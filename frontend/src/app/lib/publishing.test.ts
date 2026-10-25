import { describe, expect, it, vi } from "vitest";
import { MikeApiError } from "./mikeApi";
import {
    formatPublicationDate,
    generatePassphrase,
    isPublishable,
    publicationState,
    publishErrorMessage,
} from "./publishing";
import type { Publication } from "@/app/components/shared/types";

const pub = (over: Partial<Publication> = {}): Publication => ({
    id: "p1", document_id: "d1", version_id: "v1", title: "T", kind: "file",
    audience: "public", url: "https://x/p1", created_at: "2026-01-02T00:00:00Z",
    expires_at: null, revoked_at: null, file_count: 1, require_sign_in: false, ...over,
});

describe("isPublishable", () => {
    it("accepts the publishable types by name or type, and refuses the rest", () => {
        for (const name of ["a.HTML", "a.pdf", "a.png", "a.jpeg", "a.md", "a.txt", "a.docx", "a.ppt"]) {
            expect(isPublishable(name)).toBe(true);
        }
        expect(isPublishable("data", "pdf")).toBe(true);
        expect(isPublishable("a.xlsx", "xlsx")).toBe(false);
        expect(isPublishable("a.csv")).toBe(false);
        expect(isPublishable(null, undefined)).toBe(false);
    });
});

describe("generatePassphrase", () => {
    it("makes four hyphenated words of at least 12 characters from secure randomness", () => {
        const spy = vi.spyOn(crypto, "getRandomValues");
        const phrase = generatePassphrase();
        expect(spy).toHaveBeenCalled();
        expect(phrase.split("-")).toHaveLength(4);
        expect(phrase.length).toBeGreaterThanOrEqual(12);
        expect(phrase).toMatch(/^[a-z]+(-[a-z]+){3}$/);
        spy.mockRestore();
    });
});

describe("publishErrorMessage", () => {
    const err = (status: number, code: string | null) => new MikeApiError({ status, code, message: "raw detail" });
    it("maps known codes to plain messages and never shows raw detail", () => {
        expect(publishErrorMessage(err(400, "password_too_short"))).toMatch(/at least 12/);
        expect(publishErrorMessage(err(400, "publishing_off"))).toMatch(/turned off/);
        expect(publishErrorMessage(err(400, "unsupported_type"))).toMatch(/cannot be published/);
        expect(publishErrorMessage(err(400, "no_rendition"))).toMatch(/not ready/);
        expect(publishErrorMessage(err(400, "bad_expiry"))).toMatch(/expiry/);
        expect(publishErrorMessage(err(403, "not_owner"))).toMatch(/owner/);
        expect(publishErrorMessage(err(403, null))).toMatch(/owner/);
        expect(publishErrorMessage(err(404, null))).toMatch(/not be found/);
        expect(publishErrorMessage(err(400, "weird"))).not.toContain("raw detail");
        expect(publishErrorMessage(new Error("boom"))).toMatch(/could not be created/);
    });
});

describe("publicationState", () => {
    it("is revoked, expired or active", () => {
        const now = Date.parse("2026-06-01T00:00:00Z");
        expect(publicationState(pub({ revoked_at: "2026-01-03T00:00:00Z" }), now)).toBe("revoked");
        expect(publicationState(pub({ expires_at: "2026-05-01T00:00:00Z" }), now)).toBe("expired");
        expect(publicationState(pub({ expires_at: "2026-07-01T00:00:00Z" }), now)).toBe("active");
        expect(publicationState(pub(), now)).toBe("active");
        expect(publicationState(pub({ expires_at: "2099-01-01T00:00:00Z" }))).toBe("active");
    });
});

describe("formatPublicationDate", () => {
    it("formats a date", () => {
        expect(formatPublicationDate("2026-01-15T12:00:00Z")).toMatch(/2026/);
    });
});
