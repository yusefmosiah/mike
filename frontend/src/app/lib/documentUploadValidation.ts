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
/** Plain text attaches where images do; the backend checks it is UTF-8. */
export const SUPPORTED_TEXT_ACCEPT = ".txt,.md,.csv";
export const SUPPORTED_ATTACHMENT_ACCEPT = `${SUPPORTED_DOCUMENT_ACCEPT},${SUPPORTED_IMAGE_ACCEPT},${SUPPORTED_TEXT_ACCEPT}`;
export const UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE =
    "Unsupported file type. Only PDF, Word, Excel, PowerPoint, text (TXT, Markdown, CSV) and image (PNG, JPEG, WebP, GIF) files can be uploaded.";
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_TOO_LARGE_WARNING_MESSAGE = "Images can be at most 20 MB.";

/** Accept images and plain text as well as documents. */
export type UploadKinds = { images?: boolean; text?: boolean };

/** What attaches to a chat or a project: documents, images and plain text. */
export const ATTACHMENTS: UploadKinds = { images: true, text: true };

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
const TEXT_EXTENSIONS = new Set(["txt", "md", "csv"]);

function extensionOf(name: string): string | undefined {
    return name.split(".").pop()?.toLowerCase();
}

/** The extension a supported file type is uploaded under. */
const EXTENSION_BY_TYPE: Record<string, string> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-powerpoint": "ppt",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
};

const isKnownExtension = (extension: string | undefined) =>
    !!extension &&
    (SUPPORTED_DOCUMENT_EXTENSIONS.has(extension) ||
        IMAGE_EXTENSIONS.has(extension) ||
        TEXT_EXTENSIONS.has(extension));

/**
 * A file named by its type when its name does not say it. A screenshot
 * dragged from the iPhone's preview, or an image dropped from a web page,
 * can arrive as `image/png` named without (or with an odd) extension; the
 * checks here and on the server go by the name.
 */
export function withTypedName(file: File): File {
    const extension = EXTENSION_BY_TYPE[file.type.toLowerCase()];
    if (!extension || isKnownExtension(extensionOf(file.name))) return file;
    const base = file.name.trim() || "attachment";
    return new File([file], `${base}.${extension}`, {
        type: file.type,
        lastModified: file.lastModified,
    });
}

const isImageLike = (file: File) =>
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic|heif|tiff?)$/i.test(file.name);

const baseName = (name: string) => name.replace(/\.[^.]*$/, "").toLowerCase();

/**
 * The files a drop, paste or picker actually meant. One image dragged from
 * the iPhone (a screenshot's preview, a photo) can arrive as several copies
 * of itself in different formats, sharing a name: PNG and HEIC, say. Keep
 * one copy that can be uploaded and let the rest go unremarked, rather than
 * attaching the image and also warning that "it" is unsupported. Files that
 * are not images, and images of different names, are all kept. A file named
 * without its type's extension is given it (withTypedName).
 */
export function incomingFiles(files: File[], kinds: UploadKinds = ATTACHMENTS): File[] {
    const named = files.map(withTypedName);
    const kept: File[] = [];
    const imageGroups = new Map<string, File[]>();
    for (const file of named) {
        if (!isImageLike(file)) {
            kept.push(file);
            continue;
        }
        const key = baseName(file.name);
        const group = imageGroups.get(key);
        if (group) group.push(file);
        else {
            imageGroups.set(key, [file]);
            kept.push(file);
        }
    }
    return kept.flatMap((file) => {
        if (!isImageLike(file)) return [file];
        const group = imageGroups.get(baseName(file.name))!;
        if (group.length === 1) return [file];
        const usable = group.find((copy) => isSupportedDocumentFile(copy, kinds));
        return usable ? [usable] : group;
    });
}

/** incomingFiles for uploads that carry a folder path with each file. */
export function incomingEntries<T extends { file: File }>(
    entries: T[],
    kinds: UploadKinds = ATTACHMENTS,
): T[] {
    const named = entries.map((entry) => ({ ...entry, file: withTypedName(entry.file) }));
    const kept = new Set(incomingFiles(named.map((entry) => entry.file), kinds));
    return named.filter((entry) => kept.has(entry.file));
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
    if (kinds.text && TEXT_EXTENSIONS.has(extension)) return true;
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
    const wrongType = files.filter((file) => !isOversizedImage(file));
    // Name what was left out: "it is a PNG" is no help when the refused file
    // was something else that came along with it.
    const named = (message: string, refused: File[]) =>
        `${message} Not added: ${refused
            .slice(0, 3)
            .map((file) => file.name || "an unnamed file")
            .join(", ")}${refused.length > 3 ? ` and ${refused.length - 3} more` : ""}.`;
    if (!kinds.images && !kinds.text) {
        return named(UNSUPPORTED_DOCUMENT_WARNING_MESSAGE, files);
    }
    const oversized = files.length - wrongType.length;
    return combineUploadWarnings(
        wrongType.length ? named(UNSUPPORTED_ATTACHMENT_WARNING_MESSAGE, wrongType) : null,
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
