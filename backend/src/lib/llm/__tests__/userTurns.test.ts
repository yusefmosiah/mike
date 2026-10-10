import { describe, expect, it } from "vitest";
import { mergeConsecutiveUserTurns, USER_TURN_SEPARATOR } from "../userTurns";

describe("mergeConsecutiveUserTurns", () => {
    it("joins back-to-back user turns with a separator and leaves alternation alone", () => {
        expect(
            mergeConsecutiveUserTurns([
                { role: "user", content: "Note one" },
                { role: "user", content: "Note two" },
                { role: "assistant", content: "Reply" },
                { role: "user", content: "Question" },
            ]),
        ).toEqual([
            { role: "user", content: `Note one${USER_TURN_SEPARATOR}Note two` },
            { role: "assistant", content: "Reply" },
            { role: "user", content: "Question" },
        ]);
    });

    it("keeps image parts when either turn has them", () => {
        const image = { type: "image" as const, image: "data:image/png;base64,AA", mimeType: "image/png" };
        const [merged] = mergeConsecutiveUserTurns([
            { role: "user", content: "See this" },
            { role: "user", content: [image, { type: "text", text: "and this" }] } as never,
        ]);
        expect(merged).toEqual({
            role: "user",
            content: [{ type: "text", text: "See this" }, { type: "text", text: "---" }, image, { type: "text", text: "and this" }],
        });
    });
});
