"use client";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentProps,
    type ReactNode,
    type RefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { findPendingAskInput } from "@/app/lib/pendingAskInput";
import {
    computedPadding,
    onScrollViewportChange,
    scrollViewportOf,
} from "@/app/lib/scrollViewport";
import { LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS } from "@/app/components/ui/liquid-surface";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { CodeApprovalRequests } from "./CodeApprovalRequests";
import { ChatInput, type ChatInputHandle, type ChatInputProps } from "./ChatInput";
import { ChatInputPrompt } from "./ChatInputPrompt";
import {
    generatingNotice,
    threadHasOtherAuthors,
    threadPersonLabel,
} from "./threadAuthors";
import type {
    AssistantEvent,
    Citation,
    Document,
    Message,
    MessageSibling,
    ThreadAuthor,
} from "../shared/types";

type AssistantMessageProps = ComponentProps<typeof AssistantMessage>;

/**
 * Where the thread sits.
 *
 * - `page`: the standalone assistant. The thread is a centred column that
 *   runs under the status bar, and on a phone scrolls the page itself.
 * - `pane`: a resizable chat pane beside other panes (the project assistant).
 *   The thread fills the pane and starts below the pane's own header.
 */
export type ChatThreadVariant = "page" | "pane";

export type ChatThreadSubmit = (
    message: Message,
    options?: {
        askInputsResponse?: Extract<
            AssistantEvent,
            { type: "ask_inputs_response" }
        >;
    },
) => unknown;

export interface ChatThreadProps {
    variant?: ChatThreadVariant;
    chatId?: string | null;
    messages: Message[];
    isResponseLoading: boolean;
    /** The thread's history is still arriving: the skeleton stands in. */
    chatLoading?: boolean;
    /**
     * Whether the composer may render. While the caller's standing is
     * unknown it is left out entirely (see ChatView's `accessResolved`).
     */
    accessResolved?: boolean;
    canSend?: boolean | null;
    /** The signed-in reader. */
    viewerId: string | null;
    /** Someone whose turn is generating in this thread. */
    generatingBy?: ThreadAuthor | null;
    /** Whether the reader started this thread, and so answers code requests. */
    isHost: boolean;
    /** Branch positions keyed by message id, when the host holds them. */
    siblingById?: Record<string, MessageSibling>;
    /**
     * Shown instead of the thread once a chat has loaded with no messages.
     * Without it, an empty thread keeps its loading skeleton.
     */
    emptyState?: ReactNode;

    // Composer
    chatInputRef: RefObject<ChatInputHandle | null>;
    onSubmit: ChatThreadSubmit;
    onCancel: () => void;
    chatModel?: string | null;
    chatReasoningLevel?: NonNullable<Message["reasoning"]> | null;
    onDocumentClick?: (document: Document) => void;
    /** Remounts the composer when it changes (a fresh draft). */
    chatInputKey?: string;
    /** Extra composer settings, such as the project the chat belongs to. */
    chatInputProps?: Pick<
        ChatInputProps,
        | "projectId"
        | "projectName"
        | "projectCmNumber"
        | "enableGlobalFileDrop"
        | "dropUploadsToProject"
    >;

    // Message actions. An absent handler hides its control.
    onEditBranch?: (message: Message, content: string) => Promise<void>;
    onNavigateSibling?: (
        message: Message,
        knownIds: Array<string | number> | null,
        dir: -1 | 1,
    ) => void | Promise<void>;
    onRegenerate?: (
        assistant: Message,
        parentUser: Message,
    ) => void | Promise<void>;
    onBranchIntoNewThread?: (message: Message) => void | Promise<void>;
    onLoadSubagentTranscript?: AssistantMessageProps["onLoadSubagentTranscript"];
    /** Opens a workflow chip in the workflow modal. */
    onWorkflowClick: (workflowId: string) => void;

    // Documents
    activeCitation: Citation | null;
    onCitationClick: (citation: Citation) => void;
    onOpenCitationSource: (citation: Citation) => void;
    onCaseClick: NonNullable<AssistantMessageProps["onCaseClick"]>;
    onEditViewClick: NonNullable<AssistantMessageProps["onEditViewClick"]>;
    onOpenDocument: NonNullable<AssistantMessageProps["onOpenDocument"]>;
    onEditResolveStart: AssistantMessageProps["onEditResolveStart"];
    onEditResolved: AssistantMessageProps["onEditResolved"];
    onEditError: AssistantMessageProps["onEditError"];
    isDocReloading: (documentId: string) => boolean;
    isEditReloading: (editId: string) => boolean;
    resolvedEditStatuses: Record<string, "accepted" | "rejected">;
}

const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const CHAT_MESSAGE_TOP_PADDING = 76;
/** How close to the end of the thread counts as reading the end. */
const FOLLOW_STREAM_THRESHOLD_PX = 24;
const SCROLL_BUTTON_INPUT_GAP = 16;
const CHAT_INPUT_BOTTOM_OFFSET = 12;

const SHIMMER_CLASS =
    "theme-shimmer bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded";

/** Each variant's layout. Behaviour is the same in both. */
const LAYOUT: Record<
    ChatThreadVariant,
    {
        scroller: string;
        scrollbarGutter: string;
        content: string;
        /** Inline top padding; the pane sets its own with classes. */
        paddingTop?: string;
        fade: string;
        fadeColumn: string;
        fadeFill: string;
        backingColumn: string;
        backing: string;
        composer: string;
    }
> = {
    page: {
        scroller: "flex-1 w-full overflow-y-auto",
        scrollbarGutter: "stable both-edges",
        content:
            "w-full max-w-4xl mx-auto px-6 md:px-8 min-h-full flex flex-col relative",
        // Clear the status bar when the page runs under it.
        paddingTop: `calc(${CHAT_MESSAGE_TOP_PADDING}px + env(safe-area-inset-top, 0px))`,
        fade: "pointer-events-none absolute inset-x-0 bottom-0 z-10",
        fadeColumn: "mx-auto h-28 w-full max-w-4xl px-4 md:px-6",
        fadeFill: "assistant-chat-input-fade h-full w-full",
        backingColumn:
            "mx-auto h-[calc(var(--chat-composer-gap)+1rem)] w-full max-w-4xl px-4 md:px-6",
        backing: "h-full rounded-t-[20px] bg-app-background",
        composer: "relative z-20 w-full max-w-4xl mx-auto px-4 md:px-6",
    },
    pane: {
        scroller: "min-h-0 flex-1 w-full overflow-y-auto",
        scrollbarGutter: "stable",
        // Starts below the pane header (and, on a phone, the app's floating
        // chrome above it).
        content:
            "w-full px-4 min-h-full flex flex-col relative pt-[120px] md:pt-20",
        // Leaves the pane's scrollbar uncovered.
        fade: "pointer-events-none absolute bottom-0 left-0 right-3 z-10",
        fadeColumn: "h-28 w-full",
        fadeFill: "h-full w-full bg-gradient-to-t from-app-surface to-transparent",
        backingColumn: "h-[calc(var(--chat-composer-gap)+1rem)] w-full px-3",
        backing: "h-full rounded-t-[20px] bg-app-surface",
        composer: "relative z-20 w-full px-3",
    },
};

/** Placeholder for a thread whose history is still arriving. */
export function ChatThreadSkeleton({
    variant = "page",
}: {
    variant?: ChatThreadVariant;
}) {
    if (variant === "pane") {
        return (
            <div className="space-y-4 w-full">
                <div className="flex justify-end">
                    <div className="bg-gray-100 rounded-2xl p-4 w-3/4">
                        <div className={`${SHIMMER_CLASS} h-3 w-full`} />
                    </div>
                </div>
                <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className={`${SHIMMER_CLASS} h-3 ${i === 3 ? "w-4/6" : "w-full"}`}
                        />
                    ))}
                </div>
            </div>
        );
    }
    return (
        <div className="space-y-6 md:space-y-8 w-full">
            <div className="flex justify-end">
                <div className="bg-gray-100 rounded-2xl p-4 w-2/5">
                    <div className={`${SHIMMER_CLASS} h-4 w-full`} />
                </div>
            </div>
            <div className="space-y-3">
                {[1, 2, 3, 4].map((i) => (
                    <div
                        key={i}
                        className={`${SHIMMER_CLASS} h-4 ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * One chat thread: the messages, their scrolling, and the composer docked
 * below them. Both the standalone assistant and the project assistant render
 * it, so the two cannot drift apart; what differs between them is passed in.
 *
 * Renders positioned siblings (the scroller, the composer fade, the scroll
 * button and the composer dock), so the parent must be a `relative` flex
 * column.
 */
export function ChatThread({
    variant = "page",
    chatId,
    messages,
    isResponseLoading,
    chatLoading,
    accessResolved = true,
    canSend,
    viewerId,
    generatingBy = null,
    isHost,
    siblingById,
    emptyState,
    chatInputRef,
    onSubmit,
    onCancel,
    chatModel,
    chatReasoningLevel,
    onDocumentClick,
    chatInputKey,
    chatInputProps,
    onEditBranch,
    onNavigateSibling,
    onRegenerate,
    onBranchIntoNewThread,
    onLoadSubagentTranscript,
    onWorkflowClick,
    activeCitation,
    onCitationClick,
    onOpenCitationSource,
    onCaseClick,
    onEditViewClick,
    onOpenDocument,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    isDocReloading,
    isEditReloading,
    resolvedEditStatuses,
}: ChatThreadProps) {
    const layout = LAYOUT[variant];
    // Prompts name their sender once someone besides the reader has written.
    const showAuthors = threadHasOtherAuthors(messages, viewerId);
    // Branch controls mutate stored rows; acting while an answer streams
    // would race the turn writing into this chat.
    const branchActionsEnabled = !isResponseLoading;
    const showEmptyState =
        emptyState !== undefined && !chatLoading && messages.length === 0;

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesContentRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const measuredInputRef = useRef<HTMLDivElement>(null);
    // Seed "already in place" when messages exist at mount (a freshly created
    // chat arrives with its first message in hand). Otherwise the skeleton +
    // opacity-0 gate would flash the message out and fade it back in on every
    // remount. Existing chats mount with messages === [] and fetch async, so
    // they still start hidden and reveal once loaded.
    const hasScrolledRef = useRef(messages.length > 0 && !chatLoading);
    const positionedChatRef = useRef<string | null | undefined>(
        messages.length > 0 && !chatLoading ? chatId : undefined,
    );
    const [messagesVisible, setMessagesVisible] = useState(
        () => messages.length > 0 && !chatLoading,
    );
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollButtonVisibleRef = useRef(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = measuredInputRef.current;
        if (!el) return;
        const update = () => setInputHeight(el.offsetHeight);
        const observer = new ResizeObserver(update);
        observer.observe(el);
        update();
        return () => observer.disconnect();
        // Re-runs when the composer mounts: it is absent until access
        // resolves, and the scroll button is positioned from its height.
    }, [accessResolved]);

    useEffect(() => {
        const container = messagesContainerRef.current;
        const content = messagesContentRef.current;
        const userMessage = latestUserMessageRef.current;
        if (!container || !content || !userMessage) return;
        // Size the latest response so that, scrolled to the bottom, the latest
        // user message sits at the content's top padding below the viewport
        // top — the same place scrollLatestUserToTop puts it. Measure the real
        // scroll viewport: it is not the full dynamic viewport height.
        const update = () => {
            const messageGap =
                window.innerWidth < MOBILE_BREAKPOINT_PX ? 24 : 32;
            setMinHeight(
                `${Math.max(
                    0,
                    scrollViewportOf(container).height -
                        computedPadding(content, "top", CHAT_MESSAGE_TOP_PADDING) -
                        userMessage.offsetHeight -
                        // One list gap before the response and one before
                        // the trailing scroll anchor (messagesEndRef).
                        messageGap * 2 -
                        computedPadding(content, "bottom", DEFAULT_ASSISTANT_BOTTOM_PADDING),
                )}px`,
            );
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(container);
        observer.observe(userMessage);
        // On a phone the page scrolls, and its height changes with Safari's bars.
        window.addEventListener("resize", update);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
        };
    }, [messages.length]);

    // While an answer streams, keep its newest text in view, as long as the
    // reader is at the end of the thread. Scrolling up stops following and
    // scrolling back to the end resumes it; the answer finishing moves
    // nothing. Our own scrolls only ever move down, so any upward scroll is
    // the reader's.
    const followRef = useRef(true);
    const followStreamRef = useRef(isResponseLoading);
    const scrollToEnd = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const viewport = scrollViewportOf(c);
        const end = viewport.scrollHeight - viewport.height;
        if (end > viewport.scrollTop) viewport.scrollTo({ top: end, behavior: "auto" });
    }, []);
    useLayoutEffect(() => {
        const wasStreaming = followStreamRef.current;
        followStreamRef.current = isResponseLoading;
        // The answer's last words and its actions arrive with the end of the
        // stream, in this commit: a reader following it sees them too.
        if (wasStreaming && !isResponseLoading && followRef.current) scrollToEnd();
    }, [isResponseLoading, scrollToEnd]);

    useEffect(() => {
        const c = messagesContainerRef.current;
        const content = messagesContentRef.current;
        if (!c || !content) return;
        let frame: number | null = null;
        let lastTop = scrollViewportOf(c).scrollTop;
        const measure = () => {
            frame = null;
            const viewport = scrollViewportOf(c);
            const { scrollHeight, height } = viewport;
            const fromEnd = scrollHeight - viewport.scrollTop - height;
            // Back at the end of the thread: follow the answer again.
            if (fromEnd <= FOLLOW_STREAM_THRESHOLD_PX) followRef.current = true;
            const visible = scrollHeight > height && fromEnd > 10;
            // Avoid dispatching even an unchanged value during a busy stream:
            // React cannot always bail out eagerly while other work is queued.
            if (visible !== scrollButtonVisibleRef.current) {
                scrollButtonVisibleRef.current = visible;
                setShowScrollButton(visible);
            }
        };
        const scheduleMeasure = () => {
            if (frame === null) frame = requestAnimationFrame(measure);
        };
        const onScroll = () => {
            const top = scrollViewportOf(c).scrollTop;
            if (top < lastTop - 1) followRef.current = false;
            lastTop = top;
            scheduleMeasure();
        };
        // Measure actual layout changes, including smoothed text reveal.
        // Depending on `messages` dispatches state from an effect on every
        // streamed chunk and can exceed React's nested passive-update limit.
        // Following runs here rather than in the frame: the observer fires
        // after layout and before paint, so new text never shows below the
        // fold first.
        const observer = new ResizeObserver(() => {
            if (followStreamRef.current && followRef.current) scrollToEnd();
            scheduleMeasure();
        });
        observer.observe(c);
        observer.observe(content);
        const stopListening = onScrollViewportChange(c, onScroll);
        scheduleMeasure();
        return () => {
            observer.disconnect();
            stopListening();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [scrollToEnd]);

    const scrollToBottom = () => {
        followRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scrollLatestUserToTop = useCallback(
        (
            behavior: ScrollBehavior = "smooth",
            onPositioned?: () => void,
        ) => {
            let frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (!container || !element) return;
                    const viewport = scrollViewportOf(container);
                    const content = messagesContentRef.current;
                    // Measure both nodes in viewport coordinates. `offsetTop`
                    // can be relative to the centered inner column rather
                    // than this scrolling element, which positions a
                    // revisited thread at the wrong message.
                    const messageTop =
                        element.getBoundingClientRect().top -
                        viewport.top +
                        viewport.scrollTop;
                    viewport.scrollTo({
                        top: Math.max(
                            0,
                            messageTop -
                                (content
                                    ? computedPadding(content, "top", CHAT_MESSAGE_TOP_PADDING)
                                    : CHAT_MESSAGE_TOP_PADDING),
                        ),
                        behavior,
                    });
                    onPositioned?.();
                });
            });
            return () => cancelAnimationFrame(frame);
        },
        [],
    );

    useEffect(() => {
        if (chatLoading) return;
        const last = messages[messages.length - 1];
        if (last?.role !== "user") return;
        // A new prompt: show it at the top, with its answer following below.
        followRef.current = true;
        return scrollLatestUserToTop();
    }, [chatLoading, messages, scrollLatestUserToTop]);

    useEffect(() => {
        // A detached turn attaches before its stored history arrives. Wait for
        // that history so the ref points at the latest user message in the
        // complete transcript, rather than the turn's temporary one-message
        // overlay.
        if (!isResponseLoading || chatLoading) return;
        followRef.current = true;
        return scrollLatestUserToTop();
    }, [chatLoading, isResponseLoading, scrollLatestUserToTop]);

    const hasMessages = messages.length > 0;
    const userMessageCount = messages.filter(
        (message) => message.role === "user",
    ).length;
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        const viewingUnpositionedChat = positionedChatRef.current !== chatId;
        if (chatLoading) {
            hasScrolledRef.current = false;
            // A live detached turn keeps `messages` non-empty while history
            // loads, so the chat id/loading state—not an empty transcript—is
            // what resets the positioning gate.
            setMessagesVisible(false);
            return;
        }
        if (!hasMessages) {
            hasScrolledRef.current = false;
            positionedChatRef.current = undefined;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current || viewingUnpositionedChat) {
            if (
                userMessageCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                return scrollLatestUserToTop("auto", () => {
                    hasScrolledRef.current = true;
                    positionedChatRef.current = chatId;
                    setMessagesVisible(true);
                });
            } else {
                hasScrolledRef.current = true;
                positionedChatRef.current = chatId;
                setMessagesVisible(true);
            }
        }
        // Keep the two-frame positioning operation alive while text streams.
        // Depending on messages would cancel it before its reveal callback.
    }, [
        chatId,
        chatLoading,
        hasMessages,
        userMessageCount,
        scrollLatestUserToTop,
    ]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const renderMessages = () => {
        const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
        const lastAssistantIndex = messages
            .map((m) => m.role)
            .lastIndexOf("assistant");
        // The message still waiting on the user's input or approval, if any.
        const pendingAskInputIndex =
            findPendingAskInput(messages)?.messageIndex ?? -1;
        return messages.map((msg, i) => {
            const sibling =
                msg.sibling ??
                (msg.id ? siblingById?.[msg.id] : undefined) ??
                null;
            const siblingIds =
                msg.sibling?.ids ??
                (msg.id ? siblingById?.[msg.id]?.ids : undefined);
            // Ordered sibling ids the view was handed, when it has them; the
            // handler asks the branch API otherwise.
            const knownSiblingIds =
                siblingIds &&
                msg.id &&
                siblingIds.length > 1 &&
                siblingIds.some((id) => String(id) === msg.id)
                    ? siblingIds
                    : null;
            const previous = i > 0 ? messages[i - 1] : null;
            const parentUser =
                msg.role === "assistant" && previous?.role === "user"
                    ? previous
                    : null;
            const navigateSibling =
                branchActionsEnabled && onNavigateSibling && msg.id
                    ? (dir: -1 | 1) =>
                          void onNavigateSibling(msg, knownSiblingIds, dir)
                    : undefined;
            return (
                <div
                    key={msg.id ?? i}
                    ref={i === lastUserIndex ? latestUserMessageRef : null}
                >
                    {msg.role === "user" ? (
                        <UserMessage
                            messageId={msg.id}
                            error={msg.error}
                            sibling={sibling}
                            authorLabel={
                                showAuthors && msg.author
                                    ? threadPersonLabel(msg.author, viewerId)
                                    : null
                            }
                            onEditBranch={
                                chatId && msg.id && onEditBranch
                                    ? (content) => onEditBranch(msg, content)
                                    : undefined
                            }
                            editDisabled={!branchActionsEnabled}
                            onNavigateSibling={navigateSibling}
                            content={msg.content ?? ""}
                            files={msg.files}
                            workflow={msg.workflow}
                            onWorkflowClick={(wf) => onWorkflowClick(wf.id)}
                            onFileClick={(file) => {
                                if (!file.document_id) return;
                                onOpenDocument({
                                    documentId: file.document_id,
                                    filename: file.filename,
                                    versionId: file.version_id ?? null,
                                    versionNumber: file.version_number ?? null,
                                });
                            }}
                        />
                    ) : (
                        <AssistantMessage
                            messageId={msg.id}
                            onLoadSubagentTranscript={
                                chatId ? onLoadSubagentTranscript : undefined
                            }
                            sibling={sibling}
                            onRegenerate={
                                branchActionsEnabled &&
                                onRegenerate &&
                                parentUser?.id
                                    ? () => void onRegenerate(msg, parentUser)
                                    : undefined
                            }
                            onNavigateSibling={navigateSibling}
                            onBranchIntoNewThread={
                                branchActionsEnabled &&
                                onBranchIntoNewThread &&
                                msg.id
                                    ? () => void onBranchIntoNewThread(msg)
                                    : undefined
                            }
                            events={msg.events}
                            isStreaming={
                                i === messages.length - 1 && isResponseLoading
                            }
                            awaitingInput={i === pendingAskInputIndex}
                            isError={!!msg.error}
                            errorMessage={
                                typeof msg.error === "string"
                                    ? msg.error
                                    : undefined
                            }
                            citations={msg.citations}
                            citationStatus={msg.citationStatus}
                            activeCitation={activeCitation}
                            onCitationClick={onCitationClick}
                            onOpenCitationSource={onOpenCitationSource}
                            onCaseClick={onCaseClick}
                            minHeight={
                                i === lastAssistantIndex ? minHeight : "0px"
                            }
                            onWorkflowClick={onWorkflowClick}
                            onEditViewClick={onEditViewClick}
                            onOpenDocument={onOpenDocument}
                            onEditResolveStart={onEditResolveStart}
                            onEditResolved={onEditResolved}
                            onEditError={onEditError}
                            isDocReloading={isDocReloading}
                            isEditReloading={isEditReloading}
                            resolvedEditStatuses={resolvedEditStatuses}
                        />
                    )}
                </div>
            );
        });
    };

    return (
        <>
            {/* Scrollable messages */}
            <div
                ref={messagesContainerRef}
                data-slot="chat-messages-scroller"
                className={layout.scroller}
                style={{ scrollbarGutter: layout.scrollbarGutter }}
            >
                <div
                    ref={messagesContentRef}
                    data-slot="chat-messages-content"
                    className={layout.content}
                    style={{
                        paddingTop: layout.paddingTop,
                        // The composer's gap from the bottom of the screen.
                        paddingBottom: `calc(${DEFAULT_ASSISTANT_BOTTOM_PADDING}px + var(--chat-composer-gap) - ${CHAT_INPUT_BOTTOM_OFFSET}px)`,
                    }}
                >
                    {showEmptyState ? (
                        emptyState
                    ) : (
                        <>
                            {!messagesVisible && (
                                <ChatThreadSkeleton variant={variant} />
                            )}
                            <div
                                className="space-y-6 md:space-y-8 transition-opacity duration-150"
                                style={{ opacity: messagesVisible ? 1 : 0 }}
                            >
                                {renderMessages()}
                                <div ref={messagesEndRef} />
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div data-slot="chat-composer-fade" className={layout.fade}>
                <div className={layout.fadeColumn}>
                    <div className={layout.fadeFill} />
                </div>
            </div>

            {/* Scroll to bottom button */}
            {showScrollButton && (
                <div
                    data-slot="chat-scroll-button"
                    className="absolute left-1/2 -translate-x-1/2 z-19"
                    style={{
                        bottom: `calc(${inputHeight + SCROLL_BUTTON_INPUT_GAP}px + var(--chat-composer-gap))`,
                    }}
                >
                    <button
                        type="button"
                        aria-label="Scroll to bottom"
                        onClick={scrollToBottom}
                        className={`cursor-pointer rounded-full p-2 transition-all ${LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS}`}
                    >
                        <ArrowDown className="h-6 w-6 text-gray-500" />
                    </button>
                </div>
            )}

            {/* Chat input */}
            {accessResolved && (
                <div
                    data-slot="chat-composer-dock"
                    className="absolute bottom-0 left-0 right-0 w-full z-30 pb-[var(--chat-composer-gap)]"
                >
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-0">
                        <div className={layout.backingColumn}>
                            <div className={layout.backing} />
                        </div>
                    </div>
                    <div
                        ref={measuredInputRef}
                        data-slot="chat-composer"
                        className={layout.composer}
                    >
                        <div className="w-full rounded-t-[20px] bg-transparent">
                            <CodeApprovalRequests
                                chatId={chatId ?? null}
                                isHost={isHost}
                                watching={
                                    !!generatingBy && generatingBy.id !== viewerId
                                }
                            />
                            {generatingBy &&
                                !(isResponseLoading && generatingBy.id === viewerId) && (
                                <p
                                    role="status"
                                    className="px-2 pb-2 text-sm text-gray-600 [overflow-wrap:anywhere]"
                                >
                                    {generatingNotice(generatingBy, viewerId)}
                                </p>
                            )}
                            <ChatInputPrompt
                                messages={messages}
                                chatKey={chatId}
                                canSend={canSend}
                                chatLoading={chatLoading}
                                onSubmit={(response, content, files) => {
                                    void onSubmit(
                                        { role: "user", content, files },
                                        { askInputsResponse: response },
                                    );
                                }}
                                onCancel={onCancel}
                            >
                                <ChatInput
                                    key={chatInputKey}
                                    ref={chatInputRef}
                                    canSend={canSend}
                                    chatLoading={chatLoading}
                                    onSubmit={onSubmit}
                                    onCancel={onCancel}
                                    isLoading={isResponseLoading}
                                    canStop={
                                        !generatingBy ||
                                        generatingBy.id === viewerId
                                    }
                                    chatKey={chatId}
                                    chatModel={chatModel}
                                    chatReasoningLevel={chatReasoningLevel}
                                    onDocumentClick={onDocumentClick}
                                    {...chatInputProps}
                                />
                            </ChatInputPrompt>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
