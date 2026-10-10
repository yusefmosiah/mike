// Stable public API. Keep implementations in the topic files below.
export {
  type AccessibleChat,
  validateAccessibleProjectId,
  type ChatAccess,
  getAccessibleChat,
} from "./chat.access";
export { getChatMessages } from "./chat.messages";
export { verifyQuoteAgainstSource } from "./engine/verifyCitations";
export { threadPresence, type ThreadPresence } from "./chat.presence";
export { postChatNote } from "./chat.notes";
export {
    codeApprovalsForViewer,
    decideCodeApproval,
    guestCodeApprovalFor,
    revokeThreadCodeApproval,
    workstationHostOf,
    type CodeApprovalDecision,
    type CodeApprovalView,
} from "./chat.codeApprovals";
export { linkedPrompt, resolveLeaf, setLeaf, walkActivePath } from "./chat.tree";
export { isMessageId } from "./chat.branches";
export {
  listChats,
  createChat,
  deleteChat,
  type ChatWriteResult,
} from "./chat.crud";
export {
  listChatPeople,
  listChatGrants,
  grantChatAccess,
  revokeChatAccess,
} from "./chat.sharing";
export { updateChatSettings } from "./chat.settings";
export { getChatSubagentTranscript } from "./chat.subagents";
export { updateChatTitle, generateChatTitle } from "./chat.titles";
export { type PreparedChatStream, prepareChatStream } from "./chat.prepare";
export {
  driveChatTurn,
  resumeInterruptedChatTurn,
  transcriptFromRows,
  type ChatTurnResumeContext,
} from "./chat.turn";
export {
  devLog,
  appendAssistantEventsToMessage,
  AssistantStreamError,
  assistantStreamErrorPayload,
  ASSISTANT_ERROR_MESSAGE,
  buildCancelledAssistantMessage,
  extractCitations,
  isAbortError,
  runLLMStream,
  stripTransientAssistantEvents,
  PROJECT_EXTRA_TOOLS,
  parseChatMessages,
  parseOptionalAskInputsResponse,
  parseOptionalAttachedDocuments,
  parseOptionalChatId,
  parseOptionalDisplayedDoc,
  parseOptionalModel,
  parseOptionalReasoning,
  buildProjectDocContext,
  buildMessages,
  loadUserMessageSentTimes,
  userMessageStamper,
  type MessageTimeContext,
  buildUserPersonalisationPrompt,
  buildWorkflowStore,
  enrichWithPriorEvents,
  appendAskInputsResponseToAssistantMessage,
  runApprovedConnectorActions,
  writeApprovedConnectorFrames,
  generateSpotlightNonce,
  spotlightFilename,
  type AskInputsResponseRequest,
  type AssistantEvent,
  type ChatDocumentReference,
  type ChatMessage,
  type TabularCellStore,
  TABULAR_TOOLS,
  parseOptionalDocumentContext,
  createReservedAssistantMessageUpdater,
  createWordClientToolsAdapter,
  isClientToolCallPending,
  reserveAssistantMessage,
  submitClientToolResult,
  ACTIVE_WORD_DOCUMENT_ID,
  buildDocContext,
  buildWordChatSystemPrompt,
  withoutEmptyAssistantReservations,
} from "./engine/index";
export {
    CHAT_TITLE_FALLBACK,
    generateAssistantChatTitle,
    logChatTitleFailure,
} from "./chat.title";

export {
  persistWordDocumentEdits,
  WORD_EDIT_FORMATS,
  type WordEditApplyMode,
} from "./engine/wordDocumentEdits";
