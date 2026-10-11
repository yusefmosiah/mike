// The workspace module's facade (goals/mission-16-documents-in-workstation.md):
// the user's documents as files under ~/mike in their workstation, and the
// one way back, save_to_mike.
//
//   workspace.view.ts  — which documents, at which paths
//   workspace.sync.ts  — bringing ~/mike up to date before a turn's commands
//   workspace.save.ts  — a workstation file into a document or a version

export { buildWorkspaceView, safeSegment, uniqueName, type WorkspaceFile, type WorkspaceView } from "./workspace.view";
export { syncSkills, syncWorkspace, syncWorkspaceOncePerTurn, type WorkspaceSyncResult } from "./workspace.sync";
export { saveToMike, workspaceRelative, MAX_SAVE_BYTES, type SaveToMikeInput, type SaveToMikeResult } from "./workspace.save";
