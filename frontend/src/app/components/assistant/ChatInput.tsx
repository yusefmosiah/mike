"use client";

import {
    useState,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
    useMemo,
    type ForwardedRef,
} from "react";
import {
    ArrowDown,
    ArrowRight,
    ArrowUp,
    AudioLines,
    Check,
    ListPlus,
    Loader2,
    Mic,
    Pencil,
    Square,
    Trash2,
    Waypoints,
    X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { UploadOverlay } from "./UploadOverlay";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { useOptionalAuth } from "@/app/contexts/AuthContext";
import {
    WORKFLOW_SLASH_MENU_ID,
    WorkflowSlashMenu,
    type SlashCommandOption,
} from "./WorkflowSlashMenu";
import {
    exactSlashWorkflow,
    matchesNoResponseCommand,
    matchingSlashWorkflows,
    NO_RESPONSE_COMMAND,
    noResponseContent,
    slashCommandQuery,
    withoutSlashCommand,
    workflowSlashCommand,
} from "./workflowSlashCommands";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import {
    MODELS,
    ModelToggle,
    modelDisplayName,
    type NoModelsReason,
    type ReasoningLevel,
} from "./ModelToggle";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { WarningPopup } from "../popups/WarningPopup";
import { VoiceAppModal } from "../modals/VoiceAppModal";
import { phoneAppPromptNeeded, phoneAppUrl, rememberPhoneBrowserChoice } from "@/app/lib/voice/phoneApp";
import {
    useSelectedModel,
    useSelectedReasoning,
} from "@/app/hooks/useSelectedModel";
import { useModelVision } from "@/app/hooks/useModelVision";
import { useBlurOnOutsideTap } from "@/app/hooks/useBlurOnOutsideTap";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { Document, Message, MessageFile, Workflow } from "../shared/types";
import type { DirectoryTab } from "../shared/useDirectoryData";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { CHAT_COMPOSER_SURFACE_CLASS } from "./composerSurface";
import {
    UploadBatchError,
    failedUploadMessage,
    getAutocompactSetting,
    listWorkflows,
    setAutocompactTokens,
    uploadProjectDocuments,
    uploadStandaloneDocuments,
    type UploadProgress,
} from "@/app/lib/mikeApi";
import {
    ATTACHMENTS,
    isImageFilename,
    SUPPORTED_ATTACHMENT_ACCEPT,
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
    incomingFiles,
} from "@/app/lib/documentUploadValidation";
import { isLongPaste, pastedTextFile } from "@/app/lib/pastedText";
import { chatDraftKey, readChatDraft, writeChatDraft } from "@/app/lib/chatDraft";
import type { ChatQueueEffort } from "@/app/lib/chatQueue";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import type { ChatQueueController } from "./useChatQueue";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
    AUTOCOMPACT_COMMAND,
    parseAutocompactCommand,
    runAutocompactCommand,
    type AutocompactCommand,
    type AutocompactNotice,
} from "@/app/lib/autocompactCommand";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";
import { liveTextOf, spliceDictation } from "@/app/lib/voice/liveComposer";
import { useDictation } from "./useDictation";
import type { UseVoiceChatResult } from "@/app/hooks/useVoiceChat";
import { VoiceModePanel } from "./VoiceModePanel";

export interface ChatInputHandle {
    addDoc: (doc: Document) => void;
    addFiles: (files: File[]) => void;
    startWorkflow: (
        workflow: { id: string; title: string },
        prompt?: string,
    ) => void;
    startWorkflowDocumentSelection: (
        workflow: { id: string; title: string },
        prompt?: string,
        options?: { initialDocumentTab?: DirectoryTab },
    ) => void;
    /**
     * Sends words heard in voice mode like a typed message, with this
     * composer's model, marked as voice. False when they could not be sent
     * (the composer says why). For a voice session owned above the composer.
     */
    sendVoice: (text: string) => boolean;
}

/**
 * Hands-free voice mode in a composer, driven by a parent that outlives it:
 * `session` is the parent's `useVoiceChat`, whose `send` is this composer's
 * `sendVoice` — the new-chat screen's composer is replaced by the thread's
 * once the first turn is sent, and voice mode carries on.
 */
export type ChatInputVoice = { session: UseVoiceChatResult };

/** A prompt as edited in the composer: its new text and files. */
export type EditedPrompt = { content: string; files: MessageFile[] };

/** A sent prompt's files as composer attachments, at the versions it sent. */
function attachmentsOf(files: MessageFile[] | undefined): Document[] {
    return (files ?? []).flatMap((file) =>
        file.document_id
            ? [
                  {
                      id: file.document_id,
                      filename: file.filename,
                      file_type: file.filename.split(".").pop()?.toLowerCase() ?? null,
                      project_id: null,
                      storage_path: null,
                      pdf_storage_path: null,
                      size_bytes: null,
                      page_count: null,
                      structure_tree: null,
                      status: "ready" as const,
                      created_at: null,
                      current_version_id: file.version_id ?? null,
                      active_version_number: file.version_number ?? null,
                  },
              ]
            : [],
    );
}

export interface ChatInputProps {
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    /**
     * Whether the Stop control may stop the response arriving. False while a
     * colleague's turn generates in a shared thread: only they can stop it.
     */
    canStop?: boolean;
    /**
     * Whether the caller may write into this chat. False renders a read-only
     * composer — sending, attaching, and drop-uploads stay off, matching
     * what the server would refuse for a project viewer.
     *
     * `null` means the answer has not arrived. The composer is closed exactly
     * as for `false`, but the placeholder stays neutral: telling an owner
     * "Viewing only — sending needs edit access" for the length of a fetch,
     * on every cold load, is a wrong statement about their access, not a
     * loading state.
     */
    canSend?: boolean | null;
    /**
     * Whether this chat's history is still on its way. Kept apart from
     * `canSend` on purpose: both close the composer, but only one of them is
     * about permissions, and saying the wrong one is a lie to the reader.
     * While an answer is still streaming into the thread `isLoading` is set
     * too, and the composer says so.
     */
    chatLoading?: boolean;
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    projectName?: string;
    projectCmNumber?: string | null;
    projectId?: string;
    /** Whether window-level file drops should be captured by this composer. */
    enableGlobalFileDrop?: boolean;
    /** Whether dropped files should be added to the project or only attached. */
    dropUploadsToProject?: boolean;
    onDocumentsUploaded?: (documents: Document[]) => void;
    onDocumentClick?: (document: Document) => void;
    chatModel?: string | null;
    chatReasoningLevel?: ReasoningLevel | null;
    chatKey?: string | null;
    /**
     * A sent prompt being edited. Its text and files load into the composer,
     * where both can be changed, and sending saves them as a new version of
     * it through `onEditSubmit` instead of sending a new message. Whatever
     * was being typed before comes back when the edit is sent or cancelled.
     */
    editTarget?: Message | null;
    onEditSubmit?: (edited: EditedPrompt) => Promise<void>;
    onEditCancel?: () => void;
    /**
     * Offers hands-free voice mode (in the iPhone app, when its voice engine
     * is there): see `ChatInputVoice`.
     */
    voice?: ChatInputVoice;
    /**
     * The chat's message queue. While a turn runs, sending queues the written
     * message here instead of refusing it; the strip above the input shows
     * each entry's stamp and lets it be reordered or deleted. Absent in
     * composers that have no thread to send into later.
     */
    queue?: ChatQueueController;
}

/**
 * What the closed composer tells the reader.
 *
 * Order matters. A reader without edit access is told about the grant even
 * while the thread loads, because that is the reason that will still be true
 * afterwards. Otherwise a load in progress explains itself — and when a
 * response is running (a turn started before the reader left keeps
 * `isLoading` set when they come back) it says which one, instead of
 * inventing a permission problem.
 */
function placeholderFor({
    canSend,
    chatLoading,
    isLoading,
}: {
    canSend: boolean | null;
    chatLoading: boolean;
    isLoading: boolean;
}): string {
    if (canSend === null) return "Loading…";
    if (!canSend) return "Viewing only — sending needs edit access";
    if (!chatLoading) return "How can I help?";
    return isLoading ? "A response is still arriving…" : "Loading this chat…";
}

/** Recording length as mm:ss for the dictation indicator. */
function formatDictationTime(elapsedMs: number): string {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

/** The effort a queued message will run with, named as the picker does. */
function queuedEffortLabel(effort: ChatQueueEffort | null): string {
    if (!effort) return "Default effort";
    if (effort === "none") return "No reasoning";
    const name = effort === "xhigh" ? "XHigh" : effort[0].toUpperCase() + effort.slice(1);
    return `${name} effort`;
}

/** What a paused queue says, and the decision it asks for. */
function queuePauseCopy(reason: "stopped" | "failed" | "branch"): {
    title: string;
    detail: string;
} {
    if (reason === "stopped") {
        return {
            title: "Queue paused",
            detail: "You stopped the response. Keep the queue to send the rest, or discard it.",
        };
    }
    if (reason === "branch") {
        return {
            title: "Queue needs a decision",
            detail: "The thread branched after these were written. Keep them to send on this branch, or discard them.",
        };
    }
    return {
        title: "Queue paused after an error",
        detail: "The turn failed. Keep the queue to send the rest, or discard it.",
    };
}

/** Below this width the composer controls always hide their labels. */
const COMPACT_CONTROLS_BELOW_PX = 430;

function ChatInputForChatImpl(
    {
        onSubmit,
        onCancel,
        isLoading,
        canStop = true,
        canSend = true,
        chatLoading = false,
        hideAddDocButton,
        hideWorkflowButton,
        projectName,
        projectCmNumber,
        projectId,
        enableGlobalFileDrop = true,
        dropUploadsToProject = true,
        onDocumentsUploaded,
        onDocumentClick,
        chatModel,
        chatReasoningLevel,
        chatKey,
        editTarget = null,
        onEditSubmit,
        onEditCancel,
        voice,
        queue,
    }: ChatInputProps,
    ref: ForwardedRef<ChatInputHandle>,
) {
    // Sending needs both a grant and a loaded thread; the placeholder below
    // names whichever one is missing.
    const composerOpen = canSend === true && !chatLoading;
    const [value, setValue] = useState("");
    const auth = useOptionalAuth();
    // The draft outlives the composer: keyed remounts (switching threads,
    // the chat gaining its id) and app closes restore it from storage,
    // scoped to the account and surface so one never leaks into another's.
    const draftKey = chatDraftKey({
        userId: auth?.user?.id ?? "anonymous",
        projectId,
        chatKey: chatKey ?? "new-chat",
    });
    const [attachedDocs, setAttachedDocs] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    // Restore the stored draft once, on mount — not during render, so SSR
    // and hydration stay in sync. A set-aside draft (editing a sent prompt)
    // is what gets restored if a close interrupted the edit.
    const draftRestoredRef = useRef(false);
    useEffect(() => {
        if (draftRestoredRef.current) return;
        draftRestoredRef.current = true;
        const draft = readChatDraft(draftKey);
        if (!draft) return;
        if (draft.text) {
            setValue(draft.text);
            requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (!el) return;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
            });
        }
        if (draft.docs.length > 0) setAttachedDocs(draft.docs);
        if (draft.workflow) setSelectedWorkflow(draft.workflow);
        // Mount-only restore; draftKey is fixed for this mount's key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Every change lands in storage synchronously so a force-close keeps it.
    // While a sent prompt is being edited, the set-aside draft is what gets
    // saved — the edit lives in `value` but is not the thread's draft.
    const draftSkipPersistRef = useRef(true);
    useEffect(() => {
        if (draftSkipPersistRef.current) {
            draftSkipPersistRef.current = false;
            return;
        }
        const aside = setAsideRef.current;
        writeChatDraft(draftKey, {
            text: aside?.value ?? value,
            docs: aside?.docs ?? attachedDocs,
            workflow: aside ? aside.workflow : selectedWorkflow,
        });
    }, [value, attachedDocs, selectedWorkflow, draftKey]);
    const {
        profile,
        loading: profileLoading,
        apiKeysDegraded,
        persistChatModelSelection,
        persistChatReasoningSelection,
    } = useUserProfile();
    const configuredModels = useConfiguredModels();
    const configuredModelIds = useMemo(
        () => configuredModels.map((model) => model.id),
        [configuredModels],
    );
    // A degraded profile is the local fallback, whose router lists are empty
    // because the truth is UNKNOWN. Passing them on would let one dropped
    // /user/profile request rewrite the saved composer selection to the
    // default — permanently. null means "not loaded", which the hook leaves
    // the stored selection alone for.
    const [model, setModel] = useSelectedModel({
        selectionKey: chatKey,
        chatModel,
        lastSelectedModel: profile?.lastSelectedChatModel,
        routerSelections:
            profile && !apiKeysDegraded
                ? {
                  openRouterModels: profile.openRouterModels,
                  vercelModels: profile.vercelModels,
                  openCodeGoModels: profile.openCodeGoModels,
                  }
                : null,
        apiKeys: apiKeysDegraded ? undefined : profile?.apiKeys,
        configuredModelIds,
    });
    // Degraded profile → key availability is UNKNOWN; undefined here makes
    // every key gate (submit check + model toggle) fail open instead of
    // treating "we couldn't ask" as "no keys configured".
    const apiKeys = apiKeysDegraded ? undefined : profile?.apiKeys;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);

    // Editing a sent prompt: the draft in progress is set aside while the
    // prompt's text and files fill the composer, and comes back after.
    const setAsideRef = useRef<{
        value: string;
        docs: Document[];
        workflow: { id: string; title: string } | null;
    } | null>(null);
    const [editSaving, setEditSaving] = useState(false);
    const editId = editTarget?.id ?? null;
    useEffect(() => {
        if (editTarget) {
            if (!setAsideRef.current) {
                setAsideRef.current = {
                    value,
                    docs: attachedDocs,
                    workflow: selectedWorkflow,
                };
            }
            const content = editTarget.content ?? "";
            setValue(content);
            setAttachedDocs(attachmentsOf(editTarget.files));
            setSelectedWorkflow(null);
            requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (!el) return;
                el.focus();
                el.setSelectionRange(content.length, content.length);
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
            });
        } else if (setAsideRef.current) {
            const { value: draft, docs, workflow } = setAsideRef.current;
            setAsideRef.current = null;
            setValue(draft);
            setAttachedDocs(docs);
            setSelectedWorkflow(workflow);
            if (textareaRef.current) textareaRef.current.style.height = "auto";
        }
        // Only a change of prompt starts or ends an edit; the draft it sets
        // aside is read at that moment.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editId]);
    // A tap on the page closes the phone's keyboard (iOS will not by itself).
    useBlurOnOutsideTap(textareaRef, surfaceRef);
    const controlsRef = useRef<HTMLDivElement>(null);
    // Capture and transcription live in the hook; this composer only inserts
    // the finished transcript and shows the recording state. `disabled`
    // keeps a recording from starting while the composer is closed or a
    // response is already running.
    const dictation = useDictation({ disabled: isLoading || !composerOpen });
    // True from a send-while-dictating tap until its message is handed over.
    const [finishing, setFinishing] = useState(false);
    const finishingRef = useRef(false);
    const [compactControls, setCompactControls] = useState(false);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [docSelectorInitialTab, setDocSelectorInitialTab] =
        useState<DirectoryTab>("files");
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    // Set when the modal is opened from a pill, so it lands on that workflow
    // instead of the picker's default listing.
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >(undefined);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [noModelsWarning, setNoModelsWarning] =
        useState<NoModelsReason | null>(null);
    const [modelRequiredWarning, setModelRequiredWarning] = useState(false);
    // A phone browser's first voice tap offers the app before voice mode here.
    const [voiceAppPrompt, setVoiceAppPrompt] = useState(false);
    const [reasoningLevel, setReasoningLevel] = useSelectedReasoning({
        selectionKey: chatKey,
        chatReasoningLevel,
        lastSelectedReasoningLevel: profile?.lastSelectedReasoningLevel,
    });
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [uploadingFiles, setUploadingFiles] = useState<
        Array<{ clientId: string; filename: string }>
    >([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    // The answer to an `/autocompact` command: shown under the composer until
    // the next edit, never sent to the model.
    const [autocompactNotice, setAutocompactNotice] =
        useState<AutocompactNotice | null>(null);
    const [autocompactRunning, setAutocompactRunning] = useState(false);
    const [droppedDocuments, setDroppedDocuments] = useState<Document[]>([]);
    const [slashWorkflows, setSlashWorkflows] = useState<Workflow[] | null>(
        null,
    );
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
    const dragDepthRef = useRef(0);
    const localFileInputRef = useRef<HTMLInputElement>(null);
    const settingsSaveRef = useRef<Promise<boolean>>(Promise.resolve(true));
    // `ChatInput` keys this component by chat. Mark this generation inactive
    // during the keyed unmount so upload callbacks from the previous thread
    // cannot mutate its replacement or call outward with stale documents.
    const uploadGenerationActiveRef = useRef(true);
    useLayoutEffect(() => {
        uploadGenerationActiveRef.current = true;
        return () => {
            uploadGenerationActiveRef.current = false;
        };
    }, []);

    const handleModelChange = useCallback(
        (nextModel: string) => {
            setModel(nextModel);
            // Keep rapid picker changes ordered so the final database value
            // always matches the final visible selection.
            settingsSaveRef.current = settingsSaveRef.current
                .catch(() => false)
                .then(() => persistChatModelSelection(nextModel, chatKey));
        },
        [chatKey, persistChatModelSelection, setModel],
    );

    const handleReasoningChange = useCallback(
        (nextLevel: ReasoningLevel) => {
            setReasoningLevel(nextLevel);
            settingsSaveRef.current = settingsSaveRef.current
                .catch(() => false)
                .then(() =>
                    persistChatReasoningSelection(nextLevel, chatKey),
                );
        }, [
            chatKey,
            persistChatReasoningSelection,
            setReasoningLevel,
        ],
    );

    const chatSettingsLoading =
        !!chatKey &&
        (chatModel === undefined || chatReasoningLevel === undefined);

    const slashQuery = slashCommandQuery(value);
    const matchingWorkflows = matchingSlashWorkflows(
        slashWorkflows ?? [],
        slashQuery,
    );
    const slashCommandsLoading = slashQuery !== null && slashWorkflows === null;
    // `/nr` is built in: offered at the start of a message, whatever
    // workflows exist, and never attached to a selected workflow.
    const builtInCommands: SlashCommandOption[] = [
        ...(matchesNoResponseCommand(value, slashQuery)
            ? [{ command: NO_RESPONSE_COMMAND, description: "Add to the thread without a reply" }]
            : []),
        ...(slashQuery !== null &&
        value.trimStart().toLowerCase() === slashQuery &&
        AUTOCOMPACT_COMMAND.startsWith(slashQuery)
            ? [{ command: AUTOCOMPACT_COMMAND, description: "Set where this model's chats compact, like 500k" }]
            : []),
    ];
    const menuWorkflows = selectedWorkflow ? [] : matchingWorkflows;
    const slashOptionCount = builtInCommands.length + menuWorkflows.length;
    const slashMenuOpen =
        !slashMenuDismissed && slashQuery !== null && slashOptionCount > 0;
    const resolvedSlashIndex = Math.min(
        activeSlashIndex,
        Math.max(0, slashOptionCount - 1),
    );

    // The controls drop their labels when the full row would not fit: under
    // 430px, or narrower than the row needs with its labels (a long model
    // name, a wider system font). The needed width is measured while the
    // labels show and kept while they are hidden, so the row does not flip
    // back and forth.
    const compactControlsRef = useRef(false);
    const fullControlsWidthRef = useRef(0);
    const measureControls = useCallback(() => {
        const el = controlsRef.current;
        if (!el) return;
        if (!compactControlsRef.current) fullControlsWidthRef.current = el.scrollWidth;
        const compact =
            el.clientWidth < Math.max(COMPACT_CONTROLS_BELOW_PX, fullControlsWidthRef.current);
        if (compact === compactControlsRef.current) return;
        compactControlsRef.current = compact;
        setCompactControls(compact);
    }, []);
    useEffect(() => {
        const el = controlsRef.current;
        if (!el) return;
        const observer = new ResizeObserver(measureControls);
        observer.observe(el);
        return () => observer.disconnect();
    }, [measureControls]);
    // The labels change width too (the model's name), without resizing the row.
    useLayoutEffect(measureControls);

    useEffect(() => {
        if (!slashCommandsLoading) return;

        let cancelled = false;
        listWorkflows("assistant")
            .then((workflows) => {
                if (!cancelled) setSlashWorkflows(workflows);
            })
            .catch(() => {
                if (!cancelled) setSlashWorkflows([]);
            });

        return () => {
            cancelled = true;
        };
    }, [slashCommandsLoading]);

    // While the iPhone transcribes live, the heard words are shown in the
    // composer itself, spliced into the text that was there at the caret when
    // recording began. The composer is read-only until the final text lands
    // (or the dictation is cancelled and the original text comes back).
    const liveText = dictation.liveText;
    const liveActive = liveText !== null;
    const liveBaseRef = useRef<{ original: string; before: string; after: string } | null>(null);
    const resizeTextarea = (el: HTMLTextAreaElement) => {
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!liveText) return;
        if (!liveBaseRef.current) {
            const current = el?.value ?? "";
            const caret = el?.selectionStart ?? current.length;
            const selectionEnd = el?.selectionEnd ?? caret;
            liveBaseRef.current = {
                original: current,
                before: current.slice(0, caret),
                after: current.slice(selectionEnd),
            };
        }
        const base = liveBaseRef.current;
        setValue(spliceDictation(base.before, liveTextOf(liveText), base.after));
    }, [liveText]);
    // Keep the latest words in view as the composer grows.
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!liveActive || !el) return;
        resizeTextarea(el);
        el.scrollTop = el.scrollHeight;
    }, [liveActive, value]);

    // A finished dictation lands at the caret as ordinary editable text —
    // the composer never submits it on the user's behalf. The version
    // counter makes each transcript insert exactly once. After a live
    // dictation the final text replaces the live text in place.
    const dictatedTranscript = dictation.transcript;
    const dictatedTranscriptVersion = dictation.transcriptVersion;
    useEffect(() => {
        if (dictatedTranscriptVersion === 0 || !dictatedTranscript) return;
        const el = textareaRef.current;
        if (!el) return;
        const base = liveBaseRef.current;
        if (base) {
            liveBaseRef.current = null;
            const before = spliceDictation(base.before, dictatedTranscript, "");
            const next = spliceDictation(base.before, dictatedTranscript, base.after);
            setValue(next);
            el.value = next;
            el.setSelectionRange(before.length, before.length);
            resizeTextarea(el);
            el.focus();
            return;
        }
        const caret = el.selectionStart ?? el.value.length;
        const selectionEnd = el.selectionEnd ?? caret;
        el.setRangeText(dictatedTranscript, caret, selectionEnd, "end");
        resizeTextarea(el);
        setValue(el.value);
        el.focus();
    }, [dictatedTranscript, dictatedTranscriptVersion]);
    // A live dictation that ended without final text (cancelled, failed or
    // silent) gives the composer back exactly as it was.
    useEffect(() => {
        if (liveText || !liveBaseRef.current) return;
        const { original } = liveBaseRef.current;
        liveBaseRef.current = null;
        setValue(original);
        const el = textareaRef.current;
        if (el) {
            el.value = original;
            resizeTextarea(el);
        }
    }, [liveText]);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: Document[]) => {
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    const addAttachedDocuments = useCallback((documents: Document[]) => {
        setAttachedDocs((prev) => {
            const existing = new Set(prev.map((document) => document.id));
            return [
                ...prev,
                ...documents.filter((document) => !existing.has(document.id)),
            ];
        });
    }, []);

    const handleDroppedFiles = useCallback(
        async (files: File[]) => {
            if (!composerOpen) {
                if (canSend === false) {
                    setUploadWarning(
                        "Only someone with edit access can add documents.",
                    );
                }
                return;
            }
            const { supported, unsupported } =
                partitionSupportedDocumentFiles(incomingFiles(files), ATTACHMENTS);
            setUploadWarning(formatUnsupportedDocumentWarning(unsupported, ATTACHMENTS));
            if (supported.length === 0) return;

            const uploadInputs = supported.map((file) => ({
                file,
                clientId: crypto.randomUUID(),
            }));
            setUploadingFiles(
                uploadInputs.map(({ clientId, file }) => ({
                    clientId,
                    filename: file.name,
                })),
            );
            const addCompletedDocument = (document: Document) => {
                if (!uploadGenerationActiveRef.current) return;
                addAttachedDocuments([document]);
                setDroppedDocuments((prev) => {
                    const existing = new Set(
                        prev.map((document) => document.id),
                    );
                    return [
                        ...prev,
                        ...(existing.has(document.id) ? [] : [document]),
                    ];
                });
            };
            const handleProgress = (progress: UploadProgress<Document>) => {
                if (!uploadGenerationActiveRef.current) return;
                if (
                    progress.status === "completed" ||
                    progress.status === "error"
                ) {
                    setUploadingFiles((current) =>
                        current.filter(
                            (upload) => upload.clientId !== progress.clientId,
                        ),
                    );
                }
                if (progress.status === "completed" && progress.result) {
                    addCompletedDocument(progress.result);
                }
            };
            try {
                const uploadsToProject = dropUploadsToProject && !!projectId;
                const outcomes = uploadsToProject
                    ? await uploadProjectDocuments(projectId, uploadInputs, {
                          onProgress: handleProgress,
                      })
                    : await uploadStandaloneDocuments(uploadInputs, {
                          onProgress: handleProgress,
                      });
                if (!uploadGenerationActiveRef.current) return;
                const uploaded = outcomes.flatMap((outcome) =>
                    outcome.status === "completed" && outcome.result
                        ? [outcome.result]
                        : [],
                );
                uploaded.forEach(addCompletedDocument);
                if (uploadsToProject && uploaded.length > 0) {
                    onDocumentsUploaded?.(uploaded);
                }
                if (outcomes.some((outcome) => outcome.status === "error")) {
                    setUploadWarning(failedUploadMessage(outcomes));
                }
            } catch (error) {
                if (!uploadGenerationActiveRef.current) return;
                setUploadWarning(
                    error instanceof UploadBatchError
                        ? failedUploadMessage(error.outcomes)
                        : userFacingApiError(
                              error,
                              "Documents could not be uploaded. Please try again.",
                          ),
                );
            } finally {
                if (uploadGenerationActiveRef.current) setUploadingFiles([]);
            }
        },
        [
            addAttachedDocuments,
            canSend,
            composerOpen,
            dropUploadsToProject,
            onDocumentsUploaded,
            projectId,
        ],
    );

    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => {
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
        addFiles: (files: File[]) => {
            void handleDroppedFiles(files);
        },
        startWorkflow: (workflow, prompt) => {
            setSelectedWorkflow(workflow);
            if (prompt !== undefined) setValue(prompt);
            requestAnimationFrame(() => textareaRef.current?.focus());
        },
        startWorkflowDocumentSelection: (workflow, prompt, options) => {
            setSelectedWorkflow(workflow);
            setDocSelectorInitialTab(options?.initialDocumentTab ?? "files");
            if (prompt !== undefined) {
                setValue(prompt);
                requestAnimationFrame(() => {
                    if (!textareaRef.current) return;
                    textareaRef.current.style.height = "auto";
                    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                });
            }
            setDocSelectorOpen(true);
        },
        // Called at send time, after render: the latest model and gates.
        sendVoice: (text) => sendVoice(text),
    }));

    useEffect(() => {
        if (!enableGlobalFileDrop || !composerOpen) return;
        const hasFiles = (dataTransfer: DataTransfer | null) =>
            !!dataTransfer && Array.from(dataTransfer.types).includes("Files");

        const handleDragEnter = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setIsDraggingFiles(true);
        };
        const handleDragOver = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        };
        const handleDragLeave = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setIsDraggingFiles(false);
        };
        const handleDrop = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);
            void handleDroppedFiles(
                Array.from(event.dataTransfer?.files ?? []),
            );
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
        };
    }, [composerOpen, enableGlobalFileDrop, handleDroppedFiles]);

    const updateInput = (el: HTMLTextAreaElement) => {
        setValue(el.value);
        setAutocompactNotice(null);
        setActiveSlashIndex(0);
        setSlashMenuDismissed(false);
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const el = event.currentTarget;
        if (!composerOpen || event.clipboardData.files.length > 0) return;
        const pasted = event.clipboardData.getData("text/plain");
        // A long paste is attached as a document (lib/pastedText).
        if (isLongPaste(pasted)) {
            event.preventDefault();
            const taken = [...attachedDocs, ...uploadingFiles].map((file) => file.filename);
            void handleDroppedFiles([pastedTextFile(pasted, taken)]);
            return;
        }
        // Preserve spacing when inserting into an existing sentence or code.
        const replacesMessage = !el.value.trim()
            || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
        if (!replacesMessage) return;
        const trimmed = pasted.trim();
        if (!pasted || pasted === trimmed) return;
        event.preventDefault();
        el.setRangeText(trimmed, 0, el.value.length, "end");
        updateInput(el);
    };

    // An image goes into the message itself, so a model that cannot see would
    // be refused by the server; say so here, before anything is sent.
    const imagesAttached = attachedDocs.some((doc) => isImageFilename(doc.filename));
    const vision = useModelVision(imagesAttached && model ? [model] : []);
    const modelCannotSeeImages = imagesAttached && !!model && vision[model] === false;

    /** The attached documents as a message carries them, at their current versions. */
    const attachedFiles = () =>
        attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
            ...(d.current_version_id
                ? { version_id: d.current_version_id }
                : {}),
            ...(d.active_version_number != null
                ? { version_number: d.active_version_number }
                : {}),
        }));

    // `/nr`: the message and its attachments join the thread and no reply
    // is asked for, so no model is needed. A selected workflow stays in the
    // composer for the next message that does ask.
    const submitNote = (content: string) => {
        if (!content || isLoading) return;
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }
        const files = attachedFiles();
        setAttachedDocs([]);
        onSubmit?.({
            role: "user",
            content,
            noResponse: true,
            ...(files.length > 0 ? { files } : {}),
        });
    };

    const submitMessage = (
        query: string,
        workflow: { id: string; title: string } | null,
    ) => {
        if (!query || isLoading) return;
        if (!model) {
            setModelRequiredWarning(true);
            return;
        }
        if (
            apiKeys &&
            !isModelAvailable(model, apiKeys, configuredModelIds)
        ) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        if (modelCannotSeeImages) return;
        if (editTarget && onEditSubmit) {
            if (editSaving) return;
            // The composer keeps the edit until it is saved: a failure is
            // reported by the host, and the edit can be sent again.
            setEditSaving(true);
            void onEditSubmit({ content: query, files: attachedFiles() })
                .catch(() => undefined)
                .finally(() => setEditSaving(false));
            return;
        }
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedFiles();
        setAttachedDocs([]);
        setSelectedWorkflow(null);

        onSubmit?.({
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: workflow ?? undefined,
            model,
            reasoning: reasoningLevel,
        });
    };

    // A message written while a turn runs: the same validation as Send, then
    // stored with this moment's model and effort. Attachments are already
    // uploaded, so the entry keeps their finished references.
    const queueMessage = (
        query: string,
        workflow: { id: string; title: string } | null,
    ) => {
        if (!queue || !query) return;
        // An upload in flight has no finished reference yet; queueing now
        // would send the words without the attachment and look like it took.
        if (uploadingFiles.length > 0) return;
        if (!model) {
            setModelRequiredWarning(true);
            return;
        }
        if (
            apiKeys &&
            !isModelAvailable(model, apiKeys, configuredModelIds)
        ) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        if (modelCannotSeeImages) return;
        queue.enqueue({
            text: query,
            docs: attachedDocs,
            workflow,
            model,
            effort: reasoningLevel,
        });
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setAttachedDocs([]);
        setSelectedWorkflow(null);
    };

    // `/nr` while a turn runs: queued as its own no-reply message. The
    // selected workflow stays, as it does when a note is sent directly.
    const queueNote = (content: string) => {
        if (!queue || !content) return;
        if (uploadingFiles.length > 0) return;
        queue.enqueue({
            text: content,
            docs: attachedDocs,
            workflow: null,
            model,
            effort: reasoningLevel,
            noResponse: true,
        });
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setAttachedDocs([]);
    };

    // Voice mode: each turn the engine hears is sent like a typed message,
    // with the composer's model, marked as voice.
    const sendVoice = (text: string): boolean => {
        if (!composerOpen || !canStop) return false;
        if (!model) {
            setModelRequiredWarning(true);
            return false;
        }
        if (apiKeys && !isModelAvailable(model, apiKeys, configuredModelIds)) {
            setApiKeyModalProvider(getModelProvider(model));
            return false;
        }
        onSubmit({ role: "user", content: text, model, reasoning: reasoningLevel, voice: true });
        return true;
    };
    const voiceChat = voice?.session ?? null;
    const voiceActive = !!voiceChat && voiceChat.phase !== "off";
    // Back to the composer when voice mode ends, unless focus went elsewhere.
    const wasVoiceActive = useRef(false);
    useEffect(() => {
        const ended = wasVoiceActive.current && !voiceActive;
        wasVoiceActive.current = voiceActive;
        if (!ended) return;
        const focused = document.activeElement;
        if (!focused || focused === document.body) textareaRef.current?.focus();
    }, [voiceActive]);
    const voiceOffered =
        !!voiceChat && voiceChat.supported && composerOpen && !editTarget && !dictation.recording;

    const selectSlashWorkflow = (workflow: Workflow) => {
        if (!workflowSlashCommand(workflow)) return;
        setSelectedWorkflow({
            id: workflow.id,
            title: workflow.metadata.title,
        });
        setValue((current) => withoutSlashCommand(current));
        setSlashMenuDismissed(true);
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.focus();
        }
    };

    const selectSlashCommand = (option: SlashCommandOption) => {
        setValue(`${option.command} `);
        setSlashMenuDismissed(true);
        textareaRef.current?.focus();
    };

    const selectSlashOption = (index: number) => {
        if (index < builtInCommands.length) {
            selectSlashCommand(builtInCommands[index]);
        } else {
            selectSlashWorkflow(menuWorkflows[index - builtInCommands.length]);
        }
    };

    // `/autocompact [value]`: a setting for the selected model, answered
    // here under the composer. Nothing is sent to the model.
    const runAutocompact = async (command: AutocompactCommand) => {
        if (autocompactRunning) return;
        const label = model
            ? (configuredModels.find((option) => option.id === model)?.label ??
              MODELS.find((option) => option.id === model)?.label ??
              modelDisplayName(model))
            : "";
        setAutocompactRunning(true);
        try {
            const notice = await runAutocompactCommand(command, model, label, {
                get: getAutocompactSetting,
                set: setAutocompactTokens,
            });
            if (!uploadGenerationActiveRef.current) return;
            setAutocompactNotice(notice);
            if (notice.tone === "info") {
                setValue("");
                if (textareaRef.current) {
                    textareaRef.current.style.height = "auto";
                }
            }
        } finally {
            if (uploadGenerationActiveRef.current) setAutocompactRunning(false);
        }
    };

    // Tapping send during a dictation ends it and sends what was said. The
    // hook hands the final text back (it does not also publish it as
    // `transcript`), so it is spliced exactly once, here, and sent directly
    // rather than after a render.
    const finishAndSend = async () => {
        if (finishingRef.current) return;
        finishingRef.current = true;
        setFinishing(true);
        try {
            const liveBase = liveBaseRef.current;
            const text = await dictation.finish();
            // A failure is shown through the dictation error; the composer
            // keeps its text (a live dictation gives the original back).
            if (text === null) return;
            const el = textareaRef.current;
            let composed: string;
            if (liveBase) {
                liveBaseRef.current = null;
                composed = text
                    ? spliceDictation(liveBase.before, text, liveBase.after)
                    : liveBase.original;
            } else {
                const current = el?.value ?? value;
                const caret = el?.selectionStart ?? current.length;
                const selectionEnd = el?.selectionEnd ?? caret;
                composed = spliceDictation(
                    current.slice(0, caret),
                    text,
                    current.slice(selectionEnd),
                );
            }
            // Leave the text in the composer first: if sending is refused
            // (no model, no key), nothing said or typed is lost.
            setValue(composed);
            if (el) {
                el.value = composed;
                resizeTextarea(el);
            }
            sendComposed(composed);
        } finally {
            finishingRef.current = false;
            setFinishing(false);
        }
    };

    const handleSubmit = () => {
        if (finishingRef.current || !composerOpen) return;
        if (dictation.recording) {
            void finishAndSend();
            return;
        }
        if (liveActive) return;
        sendComposed(value);
    };

    const sendComposed = (text: string) => {
        const slashQuery = slashCommandQuery(text);
        const query = text.trim();
        if (!composerOpen) return;
        // An edited prompt is sent as written: commands apply to new messages.
        if (editTarget) {
            submitMessage(query, null);
            return;
        }
        const autocompact = parseAutocompactCommand(text);
        if (autocompact) {
            void runAutocompact(autocompact);
            return;
        }
        const note = noResponseContent(text);
        if (note !== null) {
            if (isLoading) {
                if (queue) queueNote(note);
            } else {
                submitNote(note);
            }
            return;
        }
        if (slashQuery !== null && slashWorkflows === null) return;
        const slashWorkflow = slashQuery
            ? exactSlashWorkflow(slashWorkflows ?? [], slashQuery)
            : undefined;
        if (slashWorkflow) {
            selectSlashWorkflow(slashWorkflow);
            return;
        }
        // Writing stays enabled while a turn runs: the message waits for the
        // next turn instead of being refused or cutting the current one off.
        if (isLoading) {
            if (queue) queueMessage(query, selectedWorkflow);
            return;
        }
        submitMessage(query, selectedWorkflow);
    };

    const handleActionClick = () => {
        if (isLoading) {
            if (canStop) {
                queue?.pause("stopped");
                onCancel();
            }
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (slashMenuOpen && slashOptionCount > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveSlashIndex((resolvedSlashIndex + 1) % slashOptionCount);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveSlashIndex(
                    (resolvedSlashIndex - 1 + slashOptionCount) %
                        slashOptionCount,
                );
                return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                selectSlashOption(resolvedSlashIndex);
                return;
            }
        }
        if (slashMenuOpen && e.key === "Escape") {
            e.preventDefault();
            setSlashMenuDismissed(true);
            return;
        }
        if (editTarget && e.key === "Escape") {
            e.preventDefault();
            onEditCancel?.();
            return;
        }
        // Enter starts a new line; Cmd+Enter (Ctrl+Enter off a Mac) sends —
        // while a turn runs, it queues the message instead.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <>
            <div className="relative w-full">
                {slashMenuOpen && (
                    <WorkflowSlashMenu
                        workflows={menuWorkflows}
                        activeIndex={resolvedSlashIndex}
                        onSelect={selectSlashWorkflow}
                        commands={builtInCommands}
                        onSelectCommand={selectSlashCommand}
                    />
                )}
                {voiceActive && <VoiceModePanel voice={voiceChat} />}
                <div
                    ref={surfaceRef}
                    hidden={voiceActive}
                    data-slot="chat-input-surface"
                    className={CHAT_COMPOSER_SURFACE_CLASS}
                >
                    {queue && queue.entries.length > 0 && (
                        <div
                            data-slot="chat-queue"
                            role="region"
                            aria-label="Message queue"
                            className="px-2 pt-2"
                        >
                            <div className="flex items-center justify-between gap-2 px-1">
                                <p
                                    role="status"
                                    className="text-xs font-medium text-gray-600"
                                >
                                    {queue.paused
                                        ? queuePauseCopy(queue.paused.reason)
                                              .title
                                        : `${queue.entries.length} queued ${
                                              queue.entries.length === 1
                                                  ? "message"
                                                  : "messages"
                                          }`}
                                </p>
                                <div className="flex shrink-0 items-center gap-1">
                                    {queue.paused ? (
                                        <>
                                            <TextButtonUI
                                                size="xs"
                                                onClick={queue.resume}
                                            >
                                                Keep queue
                                            </TextButtonUI>
                                            <TextButtonUI
                                                size="xs"
                                                onClick={queue.clear}
                                            >
                                                Discard
                                            </TextButtonUI>
                                        </>
                                    ) : (
                                        <TextButtonUI
                                            size="xs"
                                            onClick={queue.clear}
                                        >
                                            Clear queue
                                        </TextButtonUI>
                                    )}
                                </div>
                            </div>
                            {queue.paused && (
                                <p className="px-1 pt-0.5 text-xs text-gray-500">
                                    {queuePauseCopy(queue.paused.reason).detail}
                                </p>
                            )}
                            <ol className="flex max-h-44 flex-col gap-1.5 overflow-y-auto pt-1.5">
                                {queue.entries.map((entry, index) => (
                                    <li
                                        key={entry.id}
                                        data-slot="chat-queue-entry"
                                        className={cn(
                                            "flex items-start gap-2 rounded-xl px-2 py-1.5",
                                            LIQUID_GLASS_FLAT_CLASS,
                                        )}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm leading-5 text-gray-800 [overflow-wrap:anywhere]">
                                                {entry.text}
                                            </p>
                                            <p className="pt-0.5 text-xs text-gray-500">
                                                {entry.model
                                                    ? modelDisplayName(
                                                          entry.model,
                                                      )
                                                    : "No model"}
                                                {" · "}
                                                {queuedEffortLabel(entry.effort)}
                                                {entry.docs.length > 0
                                                    ? ` · ${entry.docs.length} ${
                                                          entry.docs.length === 1
                                                              ? "attachment"
                                                              : "attachments"
                                                      }`
                                                    : ""}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-0.5">
                                            <button
                                                type="button"
                                                aria-label={`Move queued message ${index + 1} up`}
                                                disabled={index === 0}
                                                onClick={() =>
                                                    queue.reorder(entry.id, -1)
                                                }
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-40"
                                            >
                                                <ArrowUp className="h-3.5 w-3.5" />
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={`Move queued message ${index + 1} down`}
                                                disabled={
                                                    index ===
                                                    queue.entries.length - 1
                                                }
                                                onClick={() =>
                                                    queue.reorder(entry.id, 1)
                                                }
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-40"
                                            >
                                                <ArrowDown className="h-3.5 w-3.5" />
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={`Delete queued message ${index + 1}`}
                                                onClick={() =>
                                                    queue.remove(entry.id)
                                                }
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}
                    {editTarget && (
                        <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 pt-1.5 text-xs text-gray-600">
                            <span className="inline-flex items-center gap-1.5 font-medium">
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                                Editing message
                            </span>
                            <button
                                type="button"
                                onClick={onEditCancel}
                                aria-label="Cancel editing"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200/70 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    )}
                    {/* Attached chips */}
                    {(selectedWorkflow || attachedDocs.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-blue-600 text-white border border-white/20 shadow backdrop-blur-sm">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setWorkflowModalInitialId(
                                                selectedWorkflow.id,
                                            );
                                            setWorkflowModalOpen(true);
                                        }}
                                        aria-label={`Open workflow ${selectedWorkflow.title}`}
                                        className="inline-flex min-w-0 items-center gap-1 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                    >
                                        <Waypoints className="h-2.5 w-2.5 shrink-0" />
                                        <span className="max-w-[140px] truncate">
                                            {selectedWorkflow.title}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                const documentLabel = (
                                    <>
                                        <FileTypeIcon
                                            fileType={doc.file_type}
                                            className="h-2.5 w-2.5"
                                        />
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                    </>
                                );
                                return (
                                    <div
                                        key={doc.id}
                                        className={`inline-flex items-center rounded-[10px] text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS}`}
                                    >
                                        {onDocumentClick ? (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onDocumentClick(doc)
                                                }
                                                aria-label={`Open ${doc.filename}`}
                                                className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2 transition-colors hover:text-gray-950"
                                            >
                                                {documentLabel}
                                            </button>
                                        ) : (
                                            <span className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2">
                                                {documentLabel}
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                )
                                            }
                                            aria-label={`Remove ${doc.filename}`}
                                            className="mx-1 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {autocompactNotice && (
                        <p
                            role={autocompactNotice.tone === "error" ? "alert" : "status"}
                            className={cn(
                                "px-3 pt-1.5 text-xs break-words",
                                autocompactNotice.tone === "error"
                                    ? "text-red-600"
                                    : "text-gray-600",
                            )}
                        >
                            {autocompactNotice.text}
                        </p>
                    )}

                    {modelCannotSeeImages && (
                        <p role="status" className="px-3 pt-1.5 text-xs text-gray-600">
                            This model can&apos;t see images. Choose a model marked
                            &ldquo;Sees images&rdquo; in the model menu, or remove the image.
                        </p>
                    )}

                    {isLoading && uploadingFiles.length > 0 && (
                        <p
                            role="status"
                            className="px-3 pt-1.5 text-xs text-gray-600"
                        >
                            Attachments are still uploading. Queue the message
                            when they finish.
                        </p>
                    )}

                    {uploadingFiles.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
                            {uploadingFiles.map((upload) => (
                                <div
                                    key={upload.clientId}
                                    className={`inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-xs text-gray-600 ${LIQUID_GLASS_FLAT_CLASS}`}
                                >
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    <span className="max-w-[140px] truncate">
                                        {upload.filename}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Confirmed live words only, for screen readers: the textarea itself changes too often to announce */}
                    <span aria-live="polite" className="sr-only">
                        {liveText?.confirmed ?? ""}
                    </span>

                    {/* Input */}
                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            disabled={!composerOpen}
                            readOnly={liveActive}
                            placeholder={
                                liveActive
                                    ? "Listening…"
                                    : placeholderFor({
                                          canSend,
                                          chatLoading,
                                          isLoading,
                                      })
                            }
                            value={value}
                            onChange={(event) => updateInput(event.target)}
                            onPaste={handlePaste}
                            onKeyDown={handleKeyDown}
                            role="combobox"
                            aria-autocomplete="list"
                            aria-controls={
                                slashMenuOpen
                                    ? WORKFLOW_SLASH_MENU_ID
                                    : undefined
                            }
                            aria-expanded={slashMenuOpen}
                            aria-activedescendant={
                                slashMenuOpen && slashOptionCount > 0
                                    ? `${WORKFLOW_SLASH_MENU_ID}-${resolvedSlashIndex}`
                                    : undefined
                            }
                            className="w-full resize-none overflow-x-hidden overflow-y-auto border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
                        />
                    </div>

                    {/* Controls */}
                    <div
                        ref={controlsRef}
                        data-slot="chat-input-controls"
                        className="flex items-center justify-between py-2.5 pr-2.5 pl-1.5"
                    >
                        <div className="flex items-center gap-1">
                            {!hideAddDocButton && composerOpen && (
                                <AddDocButton
                                    onLocalFiles={() => localFileInputRef.current?.click()}
                                    uploading={uploadingFiles.length > 0}
                                    onBrowseAll={() => {
                                        setDocSelectorInitialTab("files");
                                        setDocSelectorOpen(true);
                                    }}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                    hideLabel={compactControls}
                                />
                            )}
                            {!hideWorkflowButton && composerOpen && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setWorkflowModalInitialId(undefined);
                                        setWorkflowModalOpen(true);
                                    }}
                                    aria-label="Open workflows"
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors",
                                        selectedWorkflow
                                            ? "text-blue-600 hover:text-blue-700"
                                            : "text-gray-400 hover:text-gray-700",
                                    )}
                                >
                                    {selectedWorkflow ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Waypoints className="h-3.5 w-3.5" />
                                    )}
                                    <span
                                        className={
                                            compactControls
                                                ? "hidden"
                                                : "hidden sm:inline"
                                        }
                                    >
                                        Workflows
                                    </span>
                                </button>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            {!chatSettingsLoading && (
                                <ModelToggle
                                    value={model}
                                    onChange={handleModelChange}
                                    apiKeys={apiKeys}
                                    apiKeysLoading={
                                        profileLoading && !profile
                                    }
                                    openRouterModels={profile?.openRouterModels}
                                    vercelModels={profile?.vercelModels}
                                    openCodeGoModels={profile?.openCodeGoModels}
                                    compact={compactControls}
                                    onNoModelsClick={setNoModelsWarning}
                                    reasoningLevel={reasoningLevel}
                                    onReasoningChange={handleReasoningChange}
                                />
                            )}
                            {voiceOffered && (
                                <button
                                    type="button"
                                    aria-label="Start voice mode"
                                    title="Start voice mode"
                                    onClick={() => {
                                        if (phoneAppPromptNeeded()) setVoiceAppPrompt(true);
                                        else void voiceChat?.start();
                                    }}
                                    disabled={isLoading || dictation.busy}
                                    className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:text-gray-300"
                                >
                                    <AudioLines className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            )}
                            {composerOpen &&
                                (dictation.recording ? (
                                    <div className="flex h-8 items-center gap-1.5 pl-1.5 pr-0.5">
                                        <span
                                            aria-hidden="true"
                                            className="relative flex h-2 w-2"
                                        >
                                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                                            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                                        </span>
                                        <span
                                            aria-label="Dictation time"
                                            className="text-xs tabular-nums text-gray-600"
                                        >
                                            {formatDictationTime(
                                                dictation.elapsedMs,
                                            )}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label="Cancel dictation"
                                            onClick={dictation.cancel}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-900/5 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Stop dictation"
                                            onClick={dictation.toggle}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-900/5 hover:text-gray-800"
                                        >
                                            <Square
                                                className="h-3.5 w-3.5"
                                                fill="currentColor"
                                                strokeWidth={0}
                                            />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        aria-label="Dictate prompt"
                                        onClick={dictation.toggle}
                                        disabled={isLoading || dictation.busy}
                                        className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:text-gray-700 disabled:cursor-default disabled:text-gray-300"
                                    >
                                        {dictation.busy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Mic className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                ))}
                            {isLoading &&
                                queue &&
                                composerOpen &&
                                value.trim().length > 0 && (
                                    <button
                                        type="button"
                                        aria-label="Queue message"
                                        title="Queue message — sends when this response finishes"
                                        data-slot="chat-queue-button"
                                        className={cn(
                                            "relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[11px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border-0 active:enabled:scale-95 transition-all duration-150",
                                            "shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)]",
                                        )}
                                        onClick={handleSubmit}
                                        disabled={
                                            finishing ||
                                            uploadingFiles.length > 0 ||
                                            autocompactRunning ||
                                            (slashCommandsLoading &&
                                                parseAutocompactCommand(
                                                    value,
                                                ) === null) ||
                                            (modelCannotSeeImages &&
                                                noResponseContent(value) ===
                                                    null)
                                        }
                                    >
                                        <ListPlus className="h-4 w-4" />
                                    </button>
                                )}
                            <button
                                type="button"
                                aria-label={
                                    isLoading
                                        ? canStop
                                            ? "Stop response"
                                            : "Only the person generating can stop this response"
                                        : "Send message"
                                }
                                title={
                                    isLoading && !canStop
                                        ? "Only the person generating can stop this response"
                                        : undefined
                                }
                                data-slot="chat-send-button"
                                className={cn(
                                    isLoading &&
                                        !canStop &&
                                        "cursor-not-allowed opacity-40",
                                    isLoading &&
                                        queue &&
                                        composerOpen &&
                                        value.trim().length > 0
                                        ? `relative text-gray-700 rounded-[11px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default backdrop-blur-xl active:enabled:scale-95 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_FLAT_CLASS}`
                                        : "relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[11px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border-0 active:enabled:scale-95 transition-all duration-150 shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)]",
                                )}
                                onClick={handleActionClick}
                                disabled={
                                    isLoading
                                        ? !canStop
                                        : !composerOpen ||
                                          finishing ||
                                          (!value.trim() && !dictation.recording) ||
                                          autocompactRunning ||
                                          (slashCommandsLoading &&
                                              parseAutocompactCommand(value) === null) ||
                                          (modelCannotSeeImages &&
                                              noResponseContent(value) === null)
                                }
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : finishing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Only that voice mode began or ended: the live words would talk over the answer. */}
            <span aria-live="polite" className="sr-only">
                {voiceChat?.announcement}
            </span>
            <input
                ref={localFileInputRef}
                type="file"
                accept={SUPPORTED_ATTACHMENT_ACCEPT}
                multiple
                hidden
                aria-label="Upload Documents"
                disabled={!composerOpen || uploadingFiles.length > 0}
                onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    if (files.length) void handleDroppedFiles(files);
                }}
            />
            <AddDocumentsModal
                open={docSelectorOpen}
                keepMounted
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                initialSelectedDocuments={attachedDocs}
                externalUploadedDocuments={droppedDocuments}
                initialTab={docSelectorInitialTab}
                projectId={dropUploadsToProject ? projectId : undefined}
                uploadStateId={`assistant-chat:${projectId ?? "standalone"}`}
                breadcrumb={
                    selectedWorkflow
                        ? ["Assistant", selectedWorkflow.title, "Add Documents"]
                        : ["Assistant", "Add Documents"]
                }
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({
                        id: wf.id,
                        title: wf.metadata.title,
                    });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
                initialWorkflowId={workflowModalInitialId}
            />
            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                onClose={() => setApiKeyModalProvider(null)}
            />
            <VoiceAppModal
                open={voiceAppPrompt}
                appUrl={phoneAppUrl()}
                onClose={() => setVoiceAppPrompt(false)}
                onUseBrowser={() => {
                    rememberPhoneBrowserChoice();
                    setVoiceAppPrompt(false);
                    // Still inside the tap, which a browser needs to start audio.
                    void voiceChat?.start();
                }}
            />
            <NoModelsWarningPopup
                reason={noModelsWarning}
                onClose={() => setNoModelsWarning(null)}
            />
            <WarningPopup
                open={modelRequiredWarning}
                onClose={() => setModelRequiredWarning(false)}
                title="Select a model"
                message="Choose a model before sending your message."
            />
            <UploadOverlay
                open={isDraggingFiles}
                warning={
                    uploadWarning ??
                    dictation.error ??
                    // Setup shows its own failures in the panel.
                    (voiceChat?.phase === "setup" ? null : voiceChat?.error)
                }
                onWarningClose={() => {
                    setUploadWarning(null);
                    dictation.clearError();
                    voiceChat?.clearError();
                }}
            />
        </>
    );
}

const ChatInputForChat = forwardRef<ChatInputHandle, ChatInputProps>(ChatInputForChatImpl);

/**
 * Chat composer whose draft and asynchronous uploads belong to one chat key.
 * Changing the key remounts the stateful implementation; its layout cleanup
 * invalidates callbacks before the replacement composer can be displayed.
 */
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
    props,
    ref,
) {
    return (
        <ChatInputForChat
            key={props.chatKey ?? "new-chat"}
            {...props}
            ref={ref}
        />
    );
});
