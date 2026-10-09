import { beforeEach, describe, expect, it, vi } from "vitest";

const completeText = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()),
    completeText,
}));

import { generateChatTitle } from "../tabular.extract";

beforeEach(() => {
    completeText.mockReset();
});

describe("generateChatTitle", () => {
    it("retries a failed call once", async () => {
        completeText
            .mockRejectedValueOnce(new Error("socket hang up"))
            .mockResolvedValueOnce("Lease Break Clauses");
        await expect(generateChatTitle("title-model", "Which leases have break clauses?")).resolves.toBe(
            "Lease Break Clauses",
        );
        expect(completeText).toHaveBeenCalledTimes(2);
        expect(completeText).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 256 }));
    });

    it("retries an empty answer once", async () => {
        completeText.mockResolvedValueOnce("  ").mockResolvedValueOnce("Rent Review Dates");
        await expect(generateChatTitle("title-model", "When are the rent reviews?")).resolves.toBe(
            "Rent Review Dates",
        );
    });

    it("gives up after the retry, leaving the fallback to the caller", async () => {
        completeText.mockRejectedValue(new Error("provider unreachable"));
        await expect(generateChatTitle("title-model", "hi")).resolves.toBeNull();
        expect(completeText).toHaveBeenCalledTimes(2);
    });
});
