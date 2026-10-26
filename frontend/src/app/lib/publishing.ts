import { MikeApiError } from "./mikeApi";
import type { Publication } from "@/app/components/shared/types";

/** Types that can be published as a link (Office files go out as their PDF). */
const PUBLISHABLE_EXTENSIONS = new Set([
    "html", "pdf", "png", "jpg", "jpeg", "webp", "gif", "md", "txt",
    "docx", "doc", "pptx", "ppt",
    "mp3", "m4a", "wav", "ogg", "mp4", "webm", "mov",
]);

export const MIN_PASSWORD_LENGTH = 12;

function extensionOf(value: string | null | undefined): string {
    const raw = (value ?? "").toLowerCase().trim();
    return raw.slice(raw.lastIndexOf(".") + 1);
}

/** Whether a document of this file type / name can be published. */
export function isPublishable(
    filename: string | null | undefined,
    fileType?: string | null,
): boolean {
    return (
        PUBLISHABLE_EXTENSIONS.has(extensionOf(filename)) ||
        PUBLISHABLE_EXTENSIONS.has(extensionOf(fileType))
    );
}

const WORDS = [
    "amber", "anchor", "apple", "arrow", "autumn", "badger", "basil", "beacon",
    "birch", "bridge", "cedar", "cherry", "cinder", "clover", "copper", "coral",
    "crane", "daisy", "delta", "ember", "falcon", "fennel", "forest", "garnet",
    "glacier", "harbor", "hazel", "heron", "indigo", "island", "jasper", "juniper",
    "kettle", "lantern", "lemon", "linen", "lotus", "maple", "meadow", "mirror",
    "nectar", "oasis", "olive", "orchid", "otter", "pebble", "pepper", "pine",
    "quartz", "raven", "river", "saffron", "sage", "silver", "sparrow", "summit",
    "thistle", "timber", "velvet", "willow",
];

/** Four random words joined by hyphens: easy to read out, 12+ characters. */
export function generatePassphrase(): string {
    const picks = new Uint32Array(4);
    crypto.getRandomValues(picks);
    return Array.from(picks, (n) => WORDS[n % WORDS.length]).join("-");
}

export const EXPIRY_OPTIONS: { value: string; label: string; days: number | null }[] = [
    { value: "7", label: "7 days", days: 7 },
    { value: "30", label: "30 days", days: 30 },
    { value: "90", label: "90 days", days: 90 },
    { value: "never", label: "Never", days: null },
];

const PUBLISH_ERRORS: Record<string, string> = {
    publishing_off: "Publishing is turned off for this install.",
    password_too_short: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    unsupported_type: "This type of file cannot be published.",
    no_rendition: "A viewable copy of this file is not ready yet. Try again in a moment.",
    bad_expiry: "That expiry is not allowed. Choose another.",
    not_owner: "Only the owner of this document can publish it.",
};

export function publishErrorMessage(error: unknown): string {
    if (error instanceof MikeApiError) {
        if (error.code && PUBLISH_ERRORS[error.code]) return PUBLISH_ERRORS[error.code];
        if (error.status === 404) return "This document could not be found.";
        if (error.status === 403) return PUBLISH_ERRORS.not_owner;
    }
    return "The link could not be created. Please try again.";
}

export type PublicationState = "revoked" | "expired" | "active";

export function publicationState(publication: Publication, now = Date.now()): PublicationState {
    if (publication.revoked_at) return "revoked";
    if (publication.expires_at && Date.parse(publication.expires_at) <= now) return "expired";
    return "active";
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function formatPublicationDate(iso: string): string {
    return DATE.format(new Date(iso));
}
