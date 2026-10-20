import { describe, expect, it } from "vitest";
import { endAtLastUser, mergeConsecutiveUserTurns, USER_TURN_SEPARATOR } from "../userTurns";

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

describe("endAtLastUser", () => {
    it("drops what follows the newest user message, and leaves a history that already ends there alone", () => {
        const history = [
            { role: "user", content: "q1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ];
        const same = endAtLastUser(history);
        expect(same.messages).toBe(history);
        expect(same.dropped).toBe(0);
        expect(
            endAtLastUser([...history, { role: "assistant", content: "partial" }, { role: "assistant", content: "more" }]),
        ).toEqual({ messages: history, dropped: 2 });
    });

    it("has nothing to end at when there is no user message", () => {
        const only = [{ role: "assistant", content: "a" }];
        expect(endAtLastUser(only)).toEqual({ messages: only, dropped: 0 });
        expect(endAtLastUser([])).toEqual({ messages: [], dropped: 0 });
    });
});
