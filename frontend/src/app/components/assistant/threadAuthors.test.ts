import { describe, expect, it } from "vitest";

import type { Message, ThreadAuthor } from "../shared/types";
import { generatingNotice, threadHasOtherAuthors, threadPersonLabel } from "./threadAuthors";

const partner: ThreadAuthor = { id: "partner", name: "Pat Partner", email: "pat@firm.test" };
const associate: ThreadAuthor = { id: "associate", name: null, email: "assoc@firm.test" };
const unknown: ThreadAuthor = { id: "ghost", name: null, email: null };

describe("threadPersonLabel", () => {
    it("calls the reader You, and others by name, email, or Someone", () => {
        expect(threadPersonLabel(partner, "partner")).toBe("You");
        expect(threadPersonLabel(partner, "associate")).toBe("Pat Partner");
        expect(threadPersonLabel(associate, "partner")).toBe("assoc@firm.test");
        expect(threadPersonLabel(unknown, null)).toBe("Someone");
    });
});

describe("threadHasOtherAuthors", () => {
    const prompt = (author?: ThreadAuthor): Message => ({ role: "user", content: "q", ...(author ? { author } : {}) });

    it("labels a thread once someone other than the reader has written", () => {
        expect(threadHasOtherAuthors([prompt(partner), prompt()], "partner")).toBe(false);
        expect(threadHasOtherAuthors([prompt(partner), prompt(associate)], "partner")).toBe(true);
        expect(threadHasOtherAuthors([prompt(partner)], "third")).toBe(true);
        expect(threadHasOtherAuthors([], "partner")).toBe(false);
    });
});

describe("generatingNotice", () => {
    it("names a colleague, or points the reader at their own other tab", () => {
        expect(generatingNotice(partner, "associate")).toBe(
            "Pat Partner is generating a response. You can send once it finishes.",
        );
        expect(generatingNotice(partner, "partner")).toBe(
            "Your response is still being generated in another tab or window.",
        );
    });
});
