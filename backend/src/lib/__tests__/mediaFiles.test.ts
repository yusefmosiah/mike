import { describe, expect, it } from "vitest";
import { checkMediaFile, MediaRejectedError, mediaSignatureMatches } from "../mediaFiles";

const bytes = (...parts: (string | number[])[]) =>
    Uint8Array.from(
        parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
    );

describe("mediaSignatureMatches", () => {
    it("recognises each container", () => {
        expect(mediaSignatureMatches("mp3", bytes("ID3", [4, 0]))).toBe(true);
        expect(mediaSignatureMatches("mp3", bytes([0xff, 0xfb, 0x90]))).toBe(true);
        expect(mediaSignatureMatches("mp4", bytes([0, 0, 0, 0x20], "ftypisom"))).toBe(true);
        expect(mediaSignatureMatches("m4a", bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe(true);
        expect(mediaSignatureMatches("mov", bytes([0, 0, 0, 8], "wide"))).toBe(true);
        expect(mediaSignatureMatches("wav", bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBe(true);
        expect(mediaSignatureMatches("ogg", bytes("OggS", [0]))).toBe(true);
        expect(mediaSignatureMatches("WEBM", bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    });

    it("refuses other bytes, and a container under the wrong name", () => {
        expect(mediaSignatureMatches("mp4", bytes("<html><body>"))).toBe(false);
        expect(mediaSignatureMatches("mp4", bytes([0, 0, 0, 8], "wide"))).toBe(false);
        expect(mediaSignatureMatches("wav", bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBe(false);
        expect(mediaSignatureMatches("mp3", bytes("%PDF-1.7"))).toBe(false);
        expect(mediaSignatureMatches("ogg", new Uint8Array())).toBe(false);
        expect(mediaSignatureMatches("pdf", bytes("%PDF"))).toBe(false);
    });
});

describe("checkMediaFile", () => {
    it("throws for a mislabelled media file and ignores other types", () => {
        expect(() => checkMediaFile("mp4", bytes("PK", [3, 4]))).toThrow(MediaRejectedError);
        expect(() => checkMediaFile("ogg", bytes("OggS"))).not.toThrow();
        expect(() => checkMediaFile("pdf", bytes("anything"))).not.toThrow();
    });
});
