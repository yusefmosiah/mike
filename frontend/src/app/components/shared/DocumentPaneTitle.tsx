import { FileTypeIcon } from "./FileTypeIcon";
import { VersionChip } from "./VersionChip";
import { DocumentCopyButton } from "./DocumentCopyButton";

/**
 * Title row above a side panel's document view: type, name and version.
 * Fixed at h-11 so the panel's other column can start level with the view.
 */
export function DocumentPaneTitle({
    filename,
    fileType,
    versionNumber,
    documentId,
    versionId,
    copyable = false,
    onCopy,
}: {
    filename: string;
    fileType?: string | null;
    versionNumber?: number | null;
    documentId?: string;
    versionId?: string | null;
    /** Stored document types whose bytes the server can flatten to text. */
    copyable?: boolean;
    /** Rich whole-document copy while a docx editor is live below. */
    onCopy?: () => Promise<void> | undefined;
}) {
    return (
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
            <FileTypeIcon
                fileType={fileType || filename}
                className="h-3.5 w-3.5 shrink-0"
            />
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <h2
                    className="min-w-0 truncate text-xs font-medium text-gray-900"
                    title={filename}
                >
                    {filename}
                </h2>
                <VersionChip n={versionNumber} />
            </div>
            {copyable && documentId && (
                <DocumentCopyButton
                    documentId={documentId}
                    versionId={versionId ?? null}
                    onCopy={onCopy}
                />
            )}
        </div>
    );
}
