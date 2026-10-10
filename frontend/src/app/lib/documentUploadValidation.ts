export const SUPPORTED_DOCUMENT_ACCEPT =
    ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt";
export const UNSUPPORTED_DOCUMENT_WARNING_MESSAGE =
    "Unsupported file type. Only PDF, Word, Excel, and PowerPoint files can be uploaded.";

/**
 * Images upload where files attach to a chat or a project, never into
 * tabular reviews or workflow assets, which read text. The backend cleans
 * them on the way in (backend/src/lib/images.ts).
 */
export const SUPPORTED_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
export const SUPPORTED_ATTACHMENT_ACCEPT = `${SUPPORTED_DOCUMENT_ACCEPT},${SUPPORTED_IMAGE_ACCEPT}`;
export const UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE =
    "Unsupported file type. Only PDF, Word, Excel, PowerPoint, and image (PNG, JPEG, WebP, GIF) files can be uploaded.";
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_TOO_LARGE_WARNING_MESSAGE = "Images can be at most 20 MB.";

/** Accept images as well as documents. */
export type UploadKinds = { images?: boolean };

/** What attaches to a chat or a project: documents and images. */
export const ATTACHMENTS: UploadKinds = { images: true };

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
    "pdf",
    "docx",
    "doc",
    "xlsx",
    "xlsm",
    "xls",
    "pptx",
    "ppt",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function extensionOf(name: string): string | undefined {
    return name.split(".").pop()?.toLowerCase();
}

export function isImageFilename(name: string): boolean {
    const extension = extensionOf(name);
    return !!extension && IMAGE_EXTENSIONS.has(extension);
}

const isOversizedImage = (file: File) =>
    isImageFilename(file.name) && file.size > MAX_IMAGE_UPLOAD_BYTES;

export function isSupportedDocumentFile(file: File, kinds: UploadKinds = {}): boolean {
    const extension = extensionOf(file.name);
    if (!extension) return false;
    if (SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) return true;
    return !!kinds.images && IMAGE_EXTENSIONS.has(extension) && !isOversizedImage(file);
}

export function partitionSupportedDocumentFiles(files: File[], kinds: UploadKinds = {}) {
    const supported: File[] = [];
    const unsupported: File[] = [];

    for (const file of files) {
        if (isSupportedDocumentFile(file, kinds)) supported.push(file);
        else unsupported.push(file);
    }

    return { supported, unsupported };
}

export function formatUnsupportedDocumentWarning(
    files: File[],
    kinds: UploadKinds = {},
): string | null {
    if (files.length === 0) return null;
    if (!kinds.images) return UNSUPPORTED_DOCUMENT_WARNING_MESSAGE;
    const oversized = files.filter(isOversizedImage).length;
    return combineUploadWarnings(
        oversized < files.length ? UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE : null,
        oversized > 0 ? IMAGE_TOO_LARGE_WARNING_MESSAGE : null,
    );
}

/**
 * One selection can fail in two independent ways at once: some files are the
 * wrong type to even attempt, and some of the rest are refused by the upload
 * session. Both facts have to reach the user, so a surface that can produce
 * both joins them into a single strip instead of letting the second message
 * overwrite the first. Empty warnings collapse away, so callers can pass their
 * warnings unconditionally, and an identical message is not repeated.
 */
export function combineUploadWarnings(
    ...warnings: (string | null | undefined)[]
): string | null {
    const present = warnings.filter(
        (warning): warning is string => !!warning && warning.trim().length > 0,
    );
    if (present.length === 0) return null;
    return [...new Set(present)].join(" ");
}
