"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import {
    PanelRight,
    Pencil,
    Plus,
    Trash2,
    Users,
    Zap,
} from "lucide-react";
import { ChatThread } from "./ChatThread";
import { InitialView } from "./InitialView";
import { QuickActionsModal } from "./QuickActionsModal";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { useQuickActions } from "@/app/hooks/useQuickActions";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";
import type { ChatInputHandle, EditedPrompt } from "./ChatInput";
import {
    AssistantSidePanel,
    assistantSidePanelTabId,
    reorderAssistantSidePanelTabs,
    upsertAssistantSidePanelTab,
    type AssistantTabDropPosition,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ChatAccessModal } from "./ChatAccessModal";
import type {
    AssistantEvent,
    Chat,
    Citation,
    Document,
    EditAnnotation,
    Message,
    MessageSibling,
    PanelDocument,
    ThreadAuthor,
} from "../shared/types";
import {
    panelDocumentFromCaseEvent,
    panelDocumentFromCitation,
    panelDocumentType,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { watchHorizontalSwipe } from "@/app/lib/horizontalSwipe";
import { chatPanelDocuments } from "@/app/lib/chatPanelDocuments";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePageChrome } from "@/app/contexts/PageChromeContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { panelDocumentAtVersion } from "@/app/lib/panelDocumentAtVersion";
import { resolvePanelDocumentVersionResult } from "./panelDocumentVersion";
import { HeaderButtonUI, HeaderButtonsUI } from "@/shared/ui/HeaderButtonsUI";
import {
    HeaderActionsMenu,
    type HeaderActionsMenuItem,
} from "@/app/components/shared/HeaderActionsMenu";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { RenameModal } from "@/app/components/modals/RenameModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ApiKeyMissingPopup } from "@/app/components/popups/ApiKeyMissingPopup";
import {
    getModelProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";
import { can, roleFrom } from "@/app/lib/permissions";
import { useAuth } from "@/app/contexts/AuthContext";
import { useDictationContext } from "@/app/lib/voice/dictationVocabulary";
import { useVoiceChat } from "@/app/hooks/useVoiceChat";
import {
    createBranch,
    deleteDocument,
    fetchSiblings,
    getChatSubagentTranscript,
    getDocument,
    renameLibraryDocument,
    renameProjectDocument,
    setChatLeaf,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

interface Props {
    chatId?: string | null;
    chat?: Chat | null;
    chatModel?: string | null;
    chatReasoningLevel?: NonNullable<Message["reasoning"]> | null;
    messages: Message[];
    isResponseLoading: boolean;
    handleChat: (
        message: Message,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            askInputsResponse?: Extract<
                AssistantEvent,
                { type: "ask_inputs_response" }
            >;
        },
    ) => Promise<string | null>;
    /** Stop control: aborts the turn in flight. */
    cancel: () => void;
    /**
     * Set when a provider rejected the caller's API key on the last send.
     * Surfaces the fix-your-key popup; retrying is pointless until it changes.
     * `model` may be null (an ask-inputs response carries none), which only
     * costs the provider's name in the message.
     */
    rejectedApiKey?: { model: string | null } | null;
    onDismissInvalidApiKey?: () => void;
    /**
     * Whether the caller may write in this chat. The server serves the
     * standing on GET /chat/:id; surfaces that know it must pass it, so a
     * read-only caller gets the disabled composer instead of a 403 on send.
     *
     * `null` is the third answer: not known yet. It closes the composer like
     * `false` does, but says nothing about the caller's access, so the page
     * does not accuse an owner of being a viewer for the length of a fetch.
     */
    canSend?: boolean | null;
    /**
     * Whether `canSend` is known yet. While the served standing is still in
     * flight, access is unknown — neither a licence nor a refusal — so the
     * composer is not rendered at all rather than flashing the read-only
     * placeholder at a caller who does have edit access. Surfaces that know
     * the standing at mount leave this alone.
     */
    accessResolved?: boolean;
    /**
     * Whether this chat's history is still loading. Separate from `canSend`
     * so the composer can say which of the two is closing it: once the
     * standing is resolved the composer stays on the page, and a thread switch
     * reads "still arriving" (while an answer streams into the thread) or
     * "loading", not "needs edit access".
     */
    chatLoading?: boolean;
    /** Shares document previews with the initial composer before a chat exists. */
    onInitialSubmit?: (message: Message) => void;
    /** Leaves this chat for the new-chat view, without cancelling its answer. */
    onNewChat: () => void;
    /**
     * Branch position of each message, keyed by message id, as served by the
     * tree API. Hosts that already hold this pass it; otherwise the message's
     * own optional `sibling` field is used. Without either, no branch
     * controls render.
     */
    siblingById?: Record<string, MessageSibling>;
    /**
     * Called after a branch mutation — an edited sibling was saved, or the
     * chat's active leaf moved — so the host reloads the active path.
     */
    onBranchChange?: () => void;
    /**
     * Regenerates an assistant answer: the host streams a new answer to the
     * user message that prompted it (it owns the stream). Without it, no
     * regenerate control renders.
     */
    onRegenerate?: (args: {
        assistant: Message;
        parentUser: Message | null;
    }) => void | Promise<void>;
    /**
     * Saves an edited prompt as a sibling branch. When provided, the host
     * owns the whole flow (create the branch, reload the active path, and
     * stream the re-answer) and receives the original message plus the
     * edited text and files. Without it, the view creates the branch itself
     * and asks the host to reload through `onBranchChange`.
     */
    onEditPrompt?: (args: {
        message: Message;
        content: string;
        files?: Message["files"];
    }) => void | Promise<void>;
    /**
     * Voice mode: replaces a sent prompt with the whole of what the person
     * said, when they went on after it was sent (useVoiceChat's
     * `replacePrompt`). Without it, those words are sent as a new message.
     */
    onReplaceVoicePrompt?: (messageId: string, content: string) => Promise<void>;
    /**
     * Branches into a new thread from an answer: the host creates the new
     * chat and opens it. Without it, no control renders.
     */
    onBranchIntoNewThread?: (message: Message) => Promise<void>;
    /**
     * Someone whose turn is generating in this thread and that this reader
     * is not attached to, usually a colleague in a shared chat.
     */
    generatingBy?: ThreadAuthor | null;
}

const ASSISTANT_PANEL_TRANSITION_MS = 500;
const MOBILE_BREAKPOINT_PX = 768;

/** The panel document a download card, copy or chat file stands for. */
function panelDocumentForOpen(args: {
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    fileType?: string | null;
}): PanelDocument {
    return {
        document_id: args.documentId,
        title: args.filename,
        type: args.fileType
            ? resolveDocumentViewType({
                  filename: args.filename,
                  fileType: args.fileType,
              })
            : panelDocumentType(args.filename),
        metadata: [],
        quotes: [],
        version_id: args.versionId,
        version_number: args.versionNumber,
    };
}

function isSmallScreen() {
    return (
        typeof window !== "undefined" &&
        window.innerWidth < MOBILE_BREAKPOINT_PX
    );
}

export function ChatView({
    chatId,
    chat,
    chatModel,
    chatReasoningLevel,
    messages,
    isResponseLoading,
    handleChat,
    cancel,
    rejectedApiKey = null,
    onDismissInvalidApiKey,
    canSend,
    accessResolved = true,
    chatLoading,
    onInitialSubmit,
    onNewChat,
    siblingById,
    onBranchChange,
    onRegenerate,
    onEditPrompt,
    onReplaceVoicePrompt,
    onBranchIntoNewThread,
    generatingBy = null,
}: Props) {
    const router = useRouter();
    const { user } = useAuth();
    const viewerId = user?.id ?? null;
    // The model is what we asked for, so it identifies whose key was rejected.
    const rejectedKeyProvider = useMemo(
        () =>
            rejectedApiKey?.model
                ? getModelProvider(rejectedApiKey.model)
                : null,
        [rejectedApiKey],
    );
    const [deleteTarget, setDeleteTarget] = useState<PanelDocument | null>(null);
    const [deletingDocument, setDeletingDocument] = useState(false);
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [panelLoading, setPanelLoading] = useState(false);
    const [rootElement, setRootElement] = useState<HTMLElement | null>(null);
    const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
    const panelElementRef = useRef<HTMLElement | null>(null);
    const panelOpenerRef = useRef<HTMLElement | null>(null);
    const panelVisibleRef = useRef(false);
    panelVisibleRef.current = panelVisible;
    const attachPanelElement = useCallback((node: HTMLElement | null) => {
        panelElementRef.current = node;
        setPanelElement(node);
    }, []);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [openDocumentsModalOpen, setOpenDocumentsModalOpen] = useState(false);
    const [quickActionsModalOpen, setQuickActionsModalOpen] = useState(false);
    // A new chat shows the quick actions; a started one only edits them.
    const isNewChat = !!onInitialSubmit;
    const { quickActions, saveQuickAction, addQuickAction } = useQuickActions(
        isNewChat || quickActionsModalOpen,
    );
    const [actionGate, setActionGate] = useState<{
        action: string;
        requiredRole: "owner" | "editor";
        /** Overrides the role-derived heading/body for refusals that are
         *  not about the caller's role on THIS chat — the shared-chat
         *  citation case, where the documents were simply not shared. */
        title?: string;
        message?: string;
    } | null>(null);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [actionError, setActionError] = useState<{
        title: string;
        message: string;
    } | null>(null);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen, isSidebarOpen = false } = useSidebar();
    const isSidebarOpenRef = useRef(isSidebarOpen);
    isSidebarOpenRef.current = isSidebarOpen;
    const { mobileActionsContainer } = usePageChrome();
    const {
        chats,
        renameChat,
        deleteChat,
    } = useChatHistoryContext();
    const activeChat =
        (chatId ? chats?.find((entry) => entry.id === chatId) : null) ??
        chat ??
        null;
    const activeChatRole = activeChat ? roleFrom(activeChat) : null;
    // Names in this chat that dictation should spell exactly.
    useDictationContext("chat-view", {
        projectName: activeChat?.project_name,
        chatTitle: activeChat?.title,
        filenames: messages.flatMap((message) =>
            (message.files ?? []).map((file) => file.filename),
        ),
        people: [activeChat?.creator_display_name],
    });
    const panelCloseTimerRef = useRef<number | null>(null);
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeCitation =
        activeTab?.kind === "citation" ? activeTab.citation : null;

    const showPanel = useCallback(() => {
        if (!panelVisibleRef.current) {
            const active = document.activeElement;
            panelOpenerRef.current = active instanceof HTMLElement ? active : null;
        }
        if (panelCloseTimerRef.current !== null) {
            window.clearTimeout(panelCloseTimerRef.current);
            panelCloseTimerRef.current = null;
        }
        flushSync(() => {
            setSidebarOpen(false);
        });

        if (panelMounted) {
            setPanelVisible(true);
            return;
        }

        setPanelVisible(false);
        setPanelMounted(true);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => setPanelVisible(true)),
        );
    }, [panelMounted, setSidebarOpen]);

    const restoreSidebarAfterPanelClose = useCallback(() => {
        if (!isSmallScreen()) setSidebarOpen(true);
    }, [setSidebarOpen]);

    useEffect(
        () => () => {
            if (panelCloseTimerRef.current !== null) {
                window.clearTimeout(panelCloseTimerRef.current);
            }
        },
        [],
    );

    const hidePanel = useCallback(
        (afterHidden: () => void) => {
            if (panelCloseTimerRef.current !== null) {
                window.clearTimeout(panelCloseTimerRef.current);
            }
            setPanelVisible(false);
            panelCloseTimerRef.current = window.setTimeout(() => {
                panelCloseTimerRef.current = null;
                afterHidden();
            }, ASSISTANT_PANEL_TRANSITION_MS);
        },
        [],
    );

    const unmountPanel = useCallback(
        (afterUnmount?: () => void) => {
            setPanelMounted(false);
            restoreSidebarAfterPanelClose();
            afterUnmount?.();
        },
        [restoreSidebarAfterPanelClose],
    );

    /**
     * Opens the panel on the chat's own documents: every document the
     * assistant created or edited that is not already a tab, the most recent
     * selected. A chat with none leaves the panel on the document picker.
     */
    const panelOpenRequestRef = useRef(0);
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const openPanel = useCallback(async () => {
        showPanel();
        const request = ++panelOpenRequestRef.current;
        const open = new Set(tabsRef.current.map((tab) => tab.id));
        const missing = chatPanelDocuments(messages).filter(
            (entry) => !open.has(entry.documentId),
        );
        if (missing.length === 0) return;
        setPanelLoading(true);
        const resolved = await Promise.all(
            missing.map(async (entry) => {
                try {
                    const result = await resolvePanelDocumentVersionResult(
                        panelDocumentForOpen({
                            documentId: entry.documentId,
                            filename: entry.filename,
                            versionId: entry.versionId,
                            versionNumber: entry.versionNumber,
                        }),
                    );
                    return result.status === "resolved" ? result.document : null;
                } catch {
                    return null;
                }
            }),
        );
        if (request !== panelOpenRequestRef.current) return;
        setPanelLoading(false);
        const documents = resolved.filter(
            (document): document is PanelDocument => document !== null,
        );
        if (documents.length === 0) return;
        setTabs((prev) =>
            documents.reduce<AssistantSidePanelTab[]>(
                (next, document) =>
                    next.some((tab) => tab.id === assistantSidePanelTabId(document))
                        ? next
                        : upsertAssistantSidePanelTab(next, {
                              kind: "document",
                              id: assistantSidePanelTabId(document),
                              document,
                          }),
                prev,
            ),
        );
        setActiveTabId(
            (current) =>
                current ?? assistantSidePanelTabId(documents[documents.length - 1]),
        );
    }, [messages, showPanel]);

    /** Puts the panel away but keeps its tabs, as a swipe right does. */
    const dismissPanel = useCallback(
        () => hidePanel(() => unmountPanel()),
        [hidePanel, unmountPanel],
    );

    // On a phone, a swipe left opens the panel and a swipe right puts it
    // away: the mirror of the sidebar's swipes. The sidebar keeps a left
    // swipe while it is open (it closes), and the panel's own surface is
    // fenced off from the page's right swipe (`data-swipe-scope`).
    useEffect(() => {
        if (!rootElement || panelMounted) return;
        return watchHorizontalSwipe(rootElement, {
            direction: "left",
            enabled: () => isSmallScreen() && !isSidebarOpenRef.current,
            onSwipe: () => void openPanel(),
        });
    }, [rootElement, panelMounted, openPanel]);
    useEffect(() => {
        if (!panelElement || !panelVisible) return;
        return watchHorizontalSwipe(panelElement, {
            direction: "right",
            scope: "document-panel",
            enabled: isSmallScreen,
            onSwipe: dismissPanel,
        });
    }, [panelElement, panelVisible, dismissPanel]);

    // Focus follows the panel: into it when it opens (unless the person has
    // already moved on to something else), back to where it was when it closes.
    useEffect(() => {
        const panel = panelElementRef.current;
        if (!panelVisible || !panel) return;
        const active = document.activeElement;
        const opener = panelOpenerRef.current;
        if (!active || active === document.body || active === opener) {
            panel.focus({ preventScroll: true });
        }
        return () => {
            panelOpenerRef.current = null;
            const current = document.activeElement;
            if (
                opener?.isConnected &&
                (!current || current === document.body || panel.contains(current))
            ) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [panelVisible]);

    const closeAllTabs = useCallback(() => {
        hidePanel(() =>
            unmountPanel(() => {
                setTabs([]);
                setActiveTabId(null);
            }),
        );
    }, [hidePanel, unmountPanel]);

    const closeTab = useCallback(
        (id: string) => {
            // Closing the last tab leaves the panel open on its document picker; only the panel's own close control dismisses it.
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId],
    );

    const reorderTabs = useCallback(
        (
            draggedTabId: string,
            targetTabId: string,
            position: AssistantTabDropPosition,
        ) => {
            setTabs((current) =>
                reorderAssistantSidePanelTabs(
                    current,
                    draggedTabId,
                    targetTabId,
                    position,
                ),
            );
        },
        [],
    );

    /**
     * One tab per document. New citations, edits and version selections update
     * that tab; changing versions resets version-specific scroll and warnings.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => upsertAssistantSidePanelTab(prev, tab));
            setActiveTabId(tab.id);
            showPanel();
        },
        [showPanel],
    );

    /**
     * Say why a document behind this chat would not open.
     *
     * A chat can be shared without its documents, and that is the common case
     * for a standalone chat: the recipient's version lookup answers 403/404.
     * Silently returning made every citation pill a dead control with no hint
     * why. But 404 has a second reading, and the sharing sentence is a lie in
     * it: the chat's OWNER sees the same status when the document they cited
     * has since been deleted, and telling them somebody withheld their own
     * file explains nothing and points at nobody. Role decides which of the
     * two the reader is looking at.
     *
     * Only for a STANDALONE chat, though. In a project chat `activeChatRole`
     * is the role on the PROJECT, so every editor and viewer there was told
     * "the person who shared this chat has not shared its documents" about a
     * project document they can see perfectly well and that had simply been
     * deleted. Nobody shared that chat with them; they are in the project.
     * A project chat keeps the generic notice.
     *
     * Everything else — network, 5xx, a document with no versions at all —
     * is not about access and gets the plain failure notice rather than a
     * permission popup.
     */
    const reportUnresolvedDocument = useCallback(
        (status: "denied" | "unavailable") => {
            const sharedStandaloneChat =
                !activeChat?.project_id && activeChatRole !== "owner";
            if (status === "denied" && sharedStandaloneChat) {
                setActionGate({
                    action: "open this document",
                    requiredRole: "editor",
                    title: "Document not shared",
                    message:
                        "The person who shared this chat has not shared its documents.",
                });
                return;
            }
            setActionError({
                title: "Document unavailable",
                message:
                    status === "denied"
                        ? "This document is no longer available."
                        : "This document could not be opened. Please try again.",
            });
        },
        [activeChat?.project_id, activeChatRole],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        async (citation: Citation, options?: { showQuotes?: boolean }) => {
            const showQuotes = options?.showQuotes ?? true;
            const resolution = await resolvePanelDocumentVersionResult(
                panelDocumentFromCitation(citation, showQuotes, {
                    chatId: activeChat?.id ?? chatId,
                }),
            );
            if (resolution.status !== "resolved") {
                reportUnresolvedDocument(resolution.status);
                return;
            }
            const document = resolution.document;
            if (!showQuotes) {
                upsertTab({
                    kind: "document",
                    id: assistantSidePanelTabId(document),
                    document,
                });
                return;
            }
            upsertTab({
                kind: "citation",
                id: assistantSidePanelTabId(document),
                document,
                citation,
            });
        },
        [activeChat?.id, chatId, reportUnresolvedDocument, upsertTab],
    );

    const openCase = useCallback(
        (citation: Extract<AssistantEvent, { type: "case_citation" }>) => {
            const document = panelDocumentFromCaseEvent(citation);
            if (!document) return;
            upsertTab({
                kind: "document",
                id: assistantSidePanelTabId(document),
                document,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: EditAnnotation, filename: string, changeNumber?: number) => {
            const document = {
                document_id: ann.document_id,
                title: filename,
                type: panelDocumentType(filename),
                metadata: [],
                quotes: [],
                version_id: ann.version_id ?? null,
                version_number: ann.version_number ?? null,
            };
            upsertTab({
                kind: "edit",
                id: assistantSidePanelTabId(document),
                document,
                edit: ann,
                changeNumber,
            });
        },
        [upsertTab],
    );

    // --- Branching (tree chats) -------------------------------------------------
    // The message rows own presentation; this view owns the calls: saving an
    // edited copy as a sibling, moving the chat's leaf, and re-pointing the
    // leaf at a prompt so a new answer becomes a sibling of the old one.
    const branchBusyRef = useRef(false);

    /** Reads the work of a subagent one of this chat's answers delegated to. */
    const loadSubagentTranscript = useCallback(
        (childId: string) => {
            if (!chatId) return Promise.reject(new Error("No chat is open"));
            return getChatSubagentTranscript(chatId, childId);
        },
        [chatId],
    );

    /** Moves the caller's leaf and asks the host to reload the active path. */
    const moveLeaf = useCallback(
        async (leafMessageId: string) => {
            if (!chatId) return;
            await setChatLeaf(chatId, leafMessageId);
            await onBranchChange?.();
        },
        [chatId, onBranchChange],
    );

    const handleEditBranch = useCallback(
        async (message: Message, edited: EditedPrompt) => {
            const { content, files } = edited;
            if (onEditPrompt) {
                try {
                    await onEditPrompt({ message, content, files });
                } catch (error) {
                    setActionError({
                        title: "Could not save the edit",
                        message: userFacingApiError(
                            error,
                            "The edited message could not be saved. Please try again.",
                        ),
                    });
                    // The composer keeps the edit, to try again.
                    throw error;
                }
                return;
            }
            if (!chatId || !message.id || branchBusyRef.current) return;
            branchBusyRef.current = true;
            try {
                // The new row is a sibling of the edited message, and the
                // server moves this caller's leaf onto it; the host reload
                // shows the branch (and starts whatever answers it).
                await createBranch(chatId, {
                    from_message_id: message.id,
                    content,
                    files,
                    workflow: message.workflow,
                });
                await onBranchChange?.();
            } catch (error) {
                setActionError({
                    title: "Could not save the edit",
                    message: userFacingApiError(
                        error,
                        "The edited message could not be saved. Please try again.",
                    ),
                });
                throw error;
            } finally {
                branchBusyRef.current = false;
            }
        },
        [chatId, onBranchChange, onEditPrompt],
    );

    const handleNavigateSibling = useCallback(
        async (
            message: Message,
            knownIds: Array<string | number> | null,
            dir: -1 | 1,
        ) => {
            if (!chatId || !message.id || branchBusyRef.current) return;
            branchBusyRef.current = true;
            try {
                // Prefer the sibling order the view was handed; the reads that
                // feed it carry only the position, so usually this asks the
                // branch API for the ordered ids.
                let order = knownIds ? knownIds.map(String) : null;
                let current = order ? order.indexOf(message.id) : -1;
                if (!order || current < 0) {
                    const fetched = await fetchSiblings(chatId, message.id);
                    order = fetched.siblings.map((sibling) => sibling.id);
                    current =
                        fetched.index > 0
                            ? fetched.index - 1
                            : order.indexOf(message.id);
                }
                const target = current < 0 ? undefined : order?.[current + dir];
                if (target === undefined) return;
                await moveLeaf(target);
            } catch (error) {
                setActionError({
                    title: "Could not open the branch",
                    message: userFacingApiError(
                        error,
                        "This branch could not be opened. Please try again.",
                    ),
                });
            } finally {
                branchBusyRef.current = false;
            }
        },
        [chatId, moveLeaf],
    );

    const handleRegenerate = useCallback(
        async (assistant: Message, parentUser: Message | null) => {
            if (!onRegenerate) return;
            try {
                await onRegenerate({ assistant, parentUser });
            } catch (error) {
                setActionError({
                    title: "Could not regenerate",
                    message: userFacingApiError(
                        error,
                        "A new answer could not be requested. Please try again.",
                    ),
                });
            }
        },
        [onRegenerate],
    );

    const handleBranchIntoNewThread = useCallback(
        async (message: Message) => {
            if (!onBranchIntoNewThread || branchBusyRef.current) return;
            branchBusyRef.current = true;
            try {
                await onBranchIntoNewThread(message);
            } catch (error) {
                setActionError({
                    title: "Could not start a new thread",
                    message: userFacingApiError(
                        error,
                        "A new thread could not be started from this response. Please try again.",
                    ),
                });
            } finally {
                branchBusyRef.current = false;
            }
        },
        [onBranchIntoNewThread],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
    const openDocument = useCallback(
        async (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
            fileType?: string | null;
        }) => {
            // The download card's click is the same question the citation
            // pill asks, and it was answered with a bare `return`: a card
            // whose document was deleted, or never shared, did nothing at all
            // when clicked. Same resolution, same words.
            const resolution = await resolvePanelDocumentVersionResult(
                panelDocumentForOpen(args),
            );
            if (resolution.status !== "resolved") {
                reportUnresolvedDocument(resolution.status);
                return;
            }
            const document = resolution.document;
            upsertTab({
                kind: "document",
                id: assistantSidePanelTabId(document),
                document,
            });
        },
        [reportUnresolvedDocument, upsertTab],
    );

    const handleAttachedDocumentClick = useCallback(
        (document: Document) => {
            void openDocument({
                documentId: document.id,
                filename: document.filename,
                versionId: document.current_version_id ?? null,
                versionNumber: document.active_version_number ?? null,
                fileType: document.file_type,
            });
        },
        [openDocument],
    );

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Propagate the new status onto any open edit-tab for this
            // edit so DocPanel's Accept/Reject buttons flip and disable
            // (their sync effect keys off edit.status). Without this, a
            // resolve triggered from the inline EditCard or BulkEditActions
            // leaves the panel buttons looking live.
            setTabs((prev) =>
                prev.map((t) =>
                    t.kind === "edit" && t.edit.edit_id === args.editId
                        ? {
                              ...t,
                              edit: { ...t.edit, status: args.status },
                          }
                        : t,
                ),
            );
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
        },
        [],
    );

    const patchTab = useCallback(
        (
            tabId: string,
            patch: {
                warning?: string | null;
                initialScrollTop?: number | null;
            },
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.document.document_id === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    /**
     * Dismisses a tab's citation quote or tracked change, leaving the document
     * open. This drops the tab to a plain document view rather than hiding the
     * section inside the panel: reopening the same citation upserts an
     * identical tab, which by design produces no prop change, so a panel-local
     * dismissal would leave the user unable to get the quote back.
     */
    const handleCloseAnnotation = useCallback((tabId: string) => {
        setTabs((prev) => {
            const index = prev.findIndex((tab) => tab.id === tabId);
            if (index < 0 || prev[index].kind === "document") return prev;
            const { id, document, warning, initialScrollTop } = prev[index];
            const next = prev.slice();
            next[index] = {
                kind: "document",
                id,
                document,
                warning,
                initialScrollTop,
            };
            return next;
        });
    }, []);

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const chatInputRef = useRef<ChatInputHandle | null>(null);

    // Voice mode lives here, not in the composer: the new-chat screen's
    // composer gives way to the thread's when the first spoken turn is sent,
    // and the conversation carries on into the chat that turn creates. Each
    // turn goes through whichever composer is on screen, with its model.
    const voiceSession = useVoiceChat({
        chatId,
        messages,
        isResponseLoading,
        send: (text) => chatInputRef.current?.sendVoice(text) ?? false,
        replacePrompt: onReplaceVoicePrompt,
        cancelResponse: cancel,
    });

    useEffect(() => {
        if (panelMounted && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    const handleShareChat = () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "access.manage")) {
            setActionGate({
                action: "share this chat",
                requiredRole: "owner",
            });
            return;
        }
        setShareOpen(true);
    };

    const handleRenameChat = async () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "content.edit")) {
            setActionGate({
                action: "rename this chat",
                requiredRole: "editor",
            });
            return;
        }
        setRenameOpen(true);
    };

    const handleRenameSave = async (title: string) => {
        if (!activeChat) return;
        setRenaming(true);
        try {
            await renameChat(activeChat.id, title);
            setRenameOpen(false);
        } catch (error) {
            setRenameOpen(false);
            setActionError({
                title: "Chat not renamed",
                message: userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
            });
        } finally {
            setRenaming(false);
        }
    };

    const handleDeleteChat = async () => {
        if (!activeChat) return;
        if (!can(activeChatRole, "container.delete")) {
            setActionGate({
                action: "delete this chat",
                requiredRole: "owner",
            });
            return;
        }
        try {
            await deleteChat(activeChat.id);
            router.push("/assistant");
        } catch (error) {
            setActionError({
                title: "Chat not deleted",
                message: userFacingApiError(
                    error,
                    "The chat could not be deleted. Please try again.",
                ),
            });
        }
    };

    const chatActionItems: HeaderActionsMenuItem[] = [
        {
            label: "Share",
            icon: Users,
            onSelect: handleShareChat,
            disabled: !activeChat,
        },
        {
            label: "Rename",
            icon: Pencil,
            onSelect: () => void handleRenameChat(),
            disabled: !activeChat,
        },
        {
            label: "Delete",
            icon: Trash2,
            onSelect: () => void handleDeleteChat(),
            disabled: !activeChat,
            variant: "danger",
        },
    ];

    const renderChatHeaderActions = () => (
        <HeaderButtonsUI className="pointer-events-auto">
            {!isNewChat && (
                <HeaderButtonUI
                    iconOnly
                    aria-label="New chat"
                    title="New chat"
                    onClick={onNewChat}
                >
                    <Plus className="h-4 w-4" />
                </HeaderButtonUI>
            )}
            <HeaderActionsMenu
                title="Chat actions"
                items={[
                    {
                        label: "Open side panel",
                        icon: PanelRight,
                        onSelect: () => void openPanel(),
                    },
                    {
                        label: "Edit quick actions",
                        icon: Zap,
                        onSelect: () => setQuickActionsModalOpen(true),
                    },
                    ...(isNewChat ? [] : chatActionItems),
                ]}
            />
        </HeaderButtonsUI>
    );

    const renderHeaderActionSlots = () => (
        <>
            <div
                data-slot="chat-header-actions"
                className="pointer-events-none absolute right-4 top-4.5 z-30 hidden md:block md:right-8"
            >
                {renderChatHeaderActions()}
            </div>

            {mobileActionsContainer
                ? createPortal(
                      <div className="flex min-w-0 items-center justify-end overflow-visible py-2 -my-2">
                          {renderChatHeaderActions()}
                      </div>,
                      mobileActionsContainer,
                  )
                : null}
        </>
    );

    const openWorkflow = (workflowId: string) => {
        setWorkflowModalInitialId(workflowId);
        setWorkflowModalOpen(true);
    };

    // Readers of a shared chat may view its documents but not change them.
    const canWrite =
        accessResolved && (canSend === undefined || canSend === true);

    return (
        <div ref={setRootElement} className="h-full w-full flex relative">
            {/* Chat column */}
            <div className="flex min-w-0 flex-col h-full flex-1 relative">
                {renderHeaderActionSlots()}
                {onInitialSubmit ? (
                    <InitialView
                        inputRef={chatInputRef}
                        onSubmit={onInitialSubmit}
                        onDocumentClick={handleAttachedDocumentClick}
                        quickActions={quickActions}
                        onEditQuickActions={() =>
                            setQuickActionsModalOpen(true)
                        }
                        voiceSession={voiceSession}
                    />
                ) : (
                    <ChatThread
                        variant="page"
                        chatId={chatId}
                        messages={messages}
                        isResponseLoading={isResponseLoading}
                        chatLoading={chatLoading}
                        accessResolved={accessResolved}
                        canSend={canSend}
                        viewerId={viewerId}
                        generatingBy={generatingBy}
                        isHost={!!chat && !!viewerId && chat.user_id === viewerId}
                        siblingById={siblingById}
                        chatInputRef={chatInputRef}
                        voiceSession={voiceSession}
                        onSubmit={handleChat}
                        onCancel={cancel}
                        chatModel={chatModel}
                        chatReasoningLevel={chatReasoningLevel}
                        onDocumentClick={handleAttachedDocumentClick}
                        onEditBranch={handleEditBranch}
                        onNavigateSibling={handleNavigateSibling}
                        onRegenerate={onRegenerate ? handleRegenerate : undefined}
                        onBranchIntoNewThread={
                            onBranchIntoNewThread
                                ? handleBranchIntoNewThread
                                : undefined
                        }
                        onLoadSubagentTranscript={loadSubagentTranscript}
                        onWorkflowClick={openWorkflow}
                        activeCitation={activeCitation}
                        onCitationClick={(citation) => {
                            if (activeCitation === citation && activeTab) {
                                handleCloseAnnotation(activeTab.id);
                            } else {
                                void openCitation(citation);
                            }
                        }}
                        onOpenCitationSource={(citation) =>
                            void openCitation(citation, { showQuotes: false })
                        }
                        onCaseClick={openCase}
                        onEditViewClick={openEditor}
                        onOpenDocument={openDocument}
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        isDocReloading={(docId) => reloadingDocIds.has(docId)}
                        isEditReloading={(editId) => reloadingEditIds.has(editId)}
                        resolvedEditStatuses={resolvedEditStatuses}
                    />
                )}
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {shareOpen && activeChat ? (
                <ChatAccessModal
                    open={shareOpen}
                    chat={activeChat}
                    onClose={() => setShareOpen(false)}
                />
            ) : null}

            {/* TODO(contacts): GET /chat/:id (backend/src/routes/chat.ts)
                serves chat + is_owner + access_role and no ranked contact
                list, so there is nothing to thread into `contacts` here and
                the "Ask …" line cannot render on chat surfaces. Needs a
                server change (the shape project detail already returns as
                `admin_contacts`) before this popup can name anybody. */}
            <PermissionDeniedPopup
                open={!!actionGate}
                action={actionGate?.action}
                requiredRole={actionGate?.requiredRole}
                title={actionGate?.title}
                message={actionGate?.message}
                onClose={() => setActionGate(null)}
            />

            <ApiKeyMissingPopup
                open={rejectedApiKey !== null}
                title="API key rejected"
                message={`${
                    rejectedKeyProvider
                        ? `The ${providerLabel(rejectedKeyProvider)} API key`
                        : "That API key"
                } was rejected. If it is your own key, check it in Settings; otherwise contact your administrator.`}
                onClose={() => onDismissInvalidApiKey?.()}
            />
            <RenameModal
                open={renameOpen}
                breadcrumbs={["Assistant", "Rename Chat"]}
                label="Chat title"
                initialValue={activeChat?.title?.trim() || "Untitled chat"}
                saving={renaming}
                onClose={() => {
                    if (!renaming) setRenameOpen(false);
                }}
                onSave={(title) => void handleRenameSave(title)}
            />
            <WarningPopup
                open={!!actionError}
                title={actionError?.title ?? "Chat action failed"}
                message={actionError?.message ?? null}
                onClose={() => setActionError(null)}
            />

            <ConfirmPopup
                open={!!deleteTarget}
                title="Delete file?"
                message={`Delete “${deleteTarget?.title ?? "this file"}” and its versions? This cannot be undone.`}
                confirmLabel="Delete file"
                confirmVariant="danger"
                confirmStatus={deletingDocument ? "loading" : "idle"}
                onCancel={() => { if (!deletingDocument) setDeleteTarget(null); }}
                onConfirm={() => {
                    if (!deleteTarget || deletingDocument || !canWrite) return;
                    const target = deleteTarget;
                    setDeletingDocument(true);
                    void (async () => {
                        try {
                            const file = await getDocument(target.document_id);
                            if (file.can_delete !== true) {
                                setActionError({ title: "Delete failed", message: "You do not have permission to delete this file." });
                                return;
                            }
                            await deleteDocument(target.document_id);
                            setTabs((current) => {
                                const remaining = current.filter((tab) => tab.document.document_id !== target.document_id);
                                setActiveTabId((id) => remaining.some((tab) => tab.id === id) ? id : remaining[0]?.id ?? null);
                                return remaining;
                            });
                            setDeleteTarget(null);
                        } catch (cause) {
                            setActionError({ title: "Delete failed", message: userFacingApiError(cause, "This file could not be deleted. Please try again.") });
                        } finally { setDeletingDocument(false); }
                    })();
                }}
            />

            {panelMounted && (
                <div
                    ref={attachPanelElement}
                    tabIndex={-1}
                    data-swipe-scope="document-panel"
                    className={`fixed inset-0 z-40 flex justify-center outline-none p-3 max-md:pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] max-md:pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0 ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        canEdit={canWrite}
                        documentActions={(document) => ({
                            addToChatDisabled: !canWrite || !!chatLoading,
                            onAddToChat: async () => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                chatInputRef.current?.addDoc(file);
                            },
                            onRename: async (filename) => {
                                const file = await getDocument(
                                    document.document_id,
                                );
                                const updated = file.project_id
                                    ? await renameProjectDocument(
                                          file.project_id,
                                          file.id,
                                          filename,
                                      )
                                    : await renameLibraryDocument(
                                          file.library_kind === "template"
                                              ? "templates"
                                              : "files",
                                          file.id,
                                          filename,
                                      );
                                setTabs((current) =>
                                    current.map((tab) =>
                                        tab.document.document_id === file.id
                                            ? {
                                                  ...tab,
                                                  document: {
                                                      ...tab.document,
                                                      title: updated.filename,
                                                  },
                                              }
                                            : tab,
                                    ),
                                );
                            },
                            onDelete: canWrite ? () => setDeleteTarget(document) : undefined,
                        })}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        onVersionChange={(tabId, version) => setTabs((current) => current.map((tab) =>
                            tab.id === tabId ? { id: tab.id, kind: "document", document: panelDocumentAtVersion(tab.document, version) } : tab))}
                        onReorderTabs={reorderTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onCloseAnnotation={handleCloseAnnotation}
                        onScrollChange={handleScrollChange}
                        onOpenDocuments={() => setOpenDocumentsModalOpen(true)}
                        loading={panelLoading}
                        picker={
                            <AddDocumentsModal
                                inline
                                open
                                onClose={() => {}}
                                onSelect={(documents) =>
                                    documents.forEach(handleAttachedDocumentClick)
                                }
                                breadcrumb={["Assistant", "Open Documents"]}
                                uploadStateId="assistant-side-panel-inline"
                            />
                        }
                    />
                </div>
            )}

            <AddDocumentsModal
                open={openDocumentsModalOpen}
                onClose={() => setOpenDocumentsModalOpen(false)}
                onSelect={(documents) => {
                    setOpenDocumentsModalOpen(false);
                    documents.forEach(handleAttachedDocumentClick);
                }}
                breadcrumb={["Assistant", "Open Documents"]}
                uploadStateId="assistant-side-panel"
            />
            <QuickActionsModal
                open={quickActionsModalOpen}
                onClose={() => setQuickActionsModalOpen(false)}
                actions={quickActions}
                onSave={saveQuickAction}
                onCreate={addQuickAction}
            />
        </div>
    );
}
