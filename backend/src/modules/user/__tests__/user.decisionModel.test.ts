import { beforeEach, describe, expect, it, vi } from "vitest";

const { decisionModelCatalog } = vi.hoisted(() => ({ decisionModelCatalog: vi.fn() }));

vi.mock("../../../lib/guardrails/decisions", async () => ({
    ...(await vi.importActual<typeof import("../../../lib/guardrails/decisions")>(
        "../../../lib/guardrails/decisions",
    )),
    decisionModelCatalog: () => decisionModelCatalog(),
}));

import {
    getAutoModeDecisionModel,
    setAutoModeDecisionModel,
} from "../user.decisionModel";

const DECIDER = {
    value: "openrouter-decisions/perplexity/pplx-decider-v1.1-27b",
    id: "perplexity/pplx-decider-v1.1-27b",
    name: "Decider",
    inputPricePerMillion: 0.02,
    openWeights: "perplexity-ai/pplx-decider-v1.1-27b",
    medianLatencyMs: 358,
};

function profileDb(read: { data: unknown; error: unknown }, write: { error: unknown } = { error: null }) {
    const updates: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select"]) chain[method] = vi.fn(() => chain);
    chain.update = vi.fn((values: unknown) => {
        updates.push(values);
        return { eq: vi.fn(async () => write) };
    });
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => read);
    return { db: chain as never, updates };
}

beforeEach(() => {
    vi.clearAllMocks();
    decisionModelCatalog.mockResolvedValue([DECIDER]);
});

describe("getAutoModeDecisionModel", () => {
    it("returns a stored decision model", async () => {
        const { db } = profileDb({ data: { auto_mode_decision_model: DECIDER.value }, error: null });
        expect(await getAutoModeDecisionModel(db, "user-1")).toBe(DECIDER.value);
    });

    it("falls back to the default on a read error, a missing row or a stray value", async () => {
        expect(await getAutoModeDecisionModel(profileDb({ data: null, error: { message: "column does not exist" } }).db, "u")).toBeNull();
        expect(await getAutoModeDecisionModel(profileDb({ data: null, error: null }).db, "u")).toBeNull();
        expect(await getAutoModeDecisionModel(profileDb({ data: { auto_mode_decision_model: "claude-opus-5" }, error: null }).db, "u")).toBeNull();
    });
});

describe("setAutoModeDecisionModel", () => {
    it("saves a model the live catalog lists, and clears with null", async () => {
        const saved = profileDb({ data: null, error: null });
        expect(await setAutoModeDecisionModel(saved.db, "user-1", DECIDER.value)).toEqual({ ok: true, data: { model: DECIDER.value, options: [DECIDER] } });
        expect(saved.updates).toEqual([{ auto_mode_decision_model: DECIDER.value }]);

        const cleared = profileDb({ data: null, error: null });
        expect((await setAutoModeDecisionModel(cleared.db, "user-1", null)).ok).toBe(true);
        expect(cleared.updates).toEqual([{ auto_mode_decision_model: null }]);
    });

    it("rejects a model the catalog does not list, or a non-string, without writing", async () => {
        const { db, updates } = profileDb({ data: null, error: null });
        expect(await setAutoModeDecisionModel(db, "user-1", "openrouter-decisions/respan/span-01")).toMatchObject({ ok: false, kind: "validation" });
        expect(await setAutoModeDecisionModel(db, "user-1", 42)).toMatchObject({ ok: false, kind: "validation" });
        expect(updates).toEqual([]);
    });

    it("reports a failed write as an internal failure", async () => {
        const { db } = profileDb({ data: null, error: null }, { error: { message: "boom" } });
        expect(await setAutoModeDecisionModel(db, "user-1", DECIDER.value)).toMatchObject({ ok: false, kind: "error" });
    });
});
