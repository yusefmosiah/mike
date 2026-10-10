import { describe, expect, it, vi } from "vitest";

vi.mock("../../../word-addin/src/taskpane/lib/errorReporting", () => ({
    reportNetworkFailure: vi.fn(),
    reportApiFailure: vi.fn(),
}));

import { refusalMessage } from "../../../word-addin/src/taskpane/api/stream";

const reply = (status: number, body: string) => new Response(body, { status });

describe("Word turn refusals", () => {
    it("explains a turn already generating elsewhere, without the server's text", async () => {
        const message = await refusalMessage(
            reply(409, JSON.stringify({ code: "turn_in_progress", detail: "A response is already being generated for this chat.", generating: { user_id: "u1" } })),
        );
        expect(message).toBe("A response is still being generated for this chat in another window. Try again once it finishes.");
    });

    it("gives a generic message for anything else", async () => {
        expect(await refusalMessage(reply(500, "stack trace at db.ts:12"))).toBe("The chat request failed (500). Please try again.");
        expect(await refusalMessage(reply(409, JSON.stringify({ code: "other" })))).toBe("The chat request failed (409). Please try again.");
    });
});
