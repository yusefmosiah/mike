import { describe, expect, it } from "vitest";
import { isLongPaste, LONG_PASTE_CHARS, pastedTextFile } from "./pastedText";

describe("long pastes", () => {
    it("counts a paste as long by its text, not its surrounding whitespace", () => {
        expect(isLongPaste("x".repeat(LONG_PASTE_CHARS))).toBe(true);
        expect(isLongPaste(` ${"x".repeat(LONG_PASTE_CHARS - 1)}\n\n`)).toBe(false);
    });

    it("names the file apart from the other attachments", async () => {
        const first = pastedTextFile("  The agreement.\n", []);
        expect(first.name).toBe("Pasted text.txt");
        expect(first.type).toBe("text/plain");
        expect(await first.text()).toBe("The agreement.");
        expect(pastedTextFile("x", ["Pasted text.txt", "Pasted text 2.txt"]).name).toBe("Pasted text 3.txt");
    });
});
