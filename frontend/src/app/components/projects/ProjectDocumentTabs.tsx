"use client";

import type { usePublishAction } from "@/app/hooks/usePublishAction";
import { DocumentTabBar } from "@/app/components/shared/DocumentTabBar";
import type { Document, PanelDocument } from "@/app/components/shared/types";
import { isExternalSourceType } from "@/app/components/shared/types";
import { SourceTypeIcon } from "@/app/components/shared/SourceTypeIcon";
import type { TabDropPosition } from "@/app/lib/reorderTabs";
import type { DocumentPermissions } from "@/app/hooks/useDocumentPermissions";

interface Props {
    tabs: ReadonlyArray<{
        documentId: string;
        filename: string;
        versionId?: string | null;
        sourceDocument?: PanelDocument;
    }>;
    documents: ReadonlyArray<Document>;
    activeTabId: string | null;
    onActivate: (documentId: string) => void;
    onAddToChat?: (document: Document) => void;
    onDownloadDoc?: (document: Document) => Promise<void>;
    /** From usePublishAction: the Publish callback for a tab, if it may publish. */
    publishAction?: ReturnType<typeof usePublishAction>["publishAction"];
    onRenameDoc?: (documentId: string, filename: string) => Promise<void>;
    onDeleteDoc?: (documentId: string) => Promise<void>;
    documentPermissions?: (documentId: string) => DocumentPermissions;
    addToChatDisabled?: boolean;
    downloading?: boolean;
    onClose: (documentId: string) => void;
    /** Renders a trailing control that closes the whole panel (mobile overlay). */
    onClosePanel?: () => void;
    onReorder: (
        draggedId: string,
        targetId: string,
        position: TabDropPosition,
    ) => void;
}

export function ProjectDocumentTabs({
    onClosePanel,
    tabs,
    documents,
    activeTabId,
    onActivate,
    onAddToChat,
    onDownloadDoc,
    publishAction,
    onRenameDoc,
    onDeleteDoc,
    documentPermissions,
    addToChatDisabled,
    downloading,
    onClose,
    onReorder,
}: Props) {
    return (
        <DocumentTabBar
            label="Project documents"
            idPrefix="project-document"
            className="project-document-tabs"
            tabs={tabs.map((tab) => {
                const document = documents.find(
                    (document) => document.id === tab.documentId,
                );
                const sourceType = tab.sourceDocument?.type;
                const legalSource = isExternalSourceType(sourceType);
                return {
                    icon: legalSource ? <SourceTypeIcon type={sourceType} /> : undefined,
                    id: tab.documentId,
                    title: tab.filename,
                    versionNumber:
                        tab.sourceDocument?.version_number ??
                        document?.active_version_number ??
                        document?.latest_version_number,
                    actions: {
                        onAddToChat:
                            document && onAddToChat
                                ? () => onAddToChat(document)
                                : undefined,
                        onDownload:
                            document && onDownloadDoc
                                ? () => onDownloadDoc(document)
                                : undefined,
                        onPublish:
                            !legalSource && publishAction
                                ? publishAction({
                                      documentId: tab.documentId,
                                      versionId: tab.versionId,
                                      filename: tab.filename,
                                      fileType: document?.file_type,
                                  })
                                : undefined,
                        onRename:
                            !legalSource && documentPermissions?.(tab.documentId).canEdit && onRenameDoc
                                ? (name: string) =>
                                      onRenameDoc(tab.documentId, name)
                                : undefined,
                        onDelete:
                            !legalSource && documentPermissions?.(tab.documentId).canDelete && onDeleteDoc
                                ? () => onDeleteDoc(tab.documentId)
                                : undefined,
                        addToChatDisabled,
                        downloading,
                    },
                };
            })}
            activeTabId={activeTabId}
            onActivate={onActivate}
            onClose={onClose}
            onClosePanel={onClosePanel}
            onReorder={onReorder}
        />
    );
}
