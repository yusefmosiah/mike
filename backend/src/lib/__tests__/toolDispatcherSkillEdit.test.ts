import { beforeEach, describe, expect, it, vi } from "vitest";

const { runSaveSkill } = vi.hoisted(() => ({ runSaveSkill: vi.fn() }));

vi.mock("../../modules/chat/engine/tools/skillTools", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../modules/chat/engine/tools/skillTools")>()),
    runSaveSkill: (...args: unknown[]) => runSaveSkill(...args),
}));

import { runToolCalls } from "../../modules/chat/engine/tools/toolDispatcher";
import type { WorkflowStore } from "../../modules/chat/engine/types";

const SAVED = {
    skillId: "w1",
    name: "deal-memo",
    title: "deal-memo",
    versionNumber: 2,
    created: false,
    description: "Deal memos my way.",
    files: null,
    filesPath: null,
};

function call(name: string, args: Record<string, unknown>, store: WorkflowStore) {
    return runToolCalls(
        [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
        new Map(),
        "user-1",
        {} as never,
        () => undefined,
        store,
    );
}

const content = (result: Awaited<ReturnType<typeof runToolCalls>>) =>
    (result.toolResults[0] as { content: string }).content;

describe("changing a saved skill from chat", () => {
    beforeEach(() => {
        runSaveSkill.mockReset();
        runSaveSkill.mockResolvedValue({ ok: true, saved: SAVED, body: "# Deal memo, v2" });
    });

    it("refuses to overwrite a skill whose text was not read this turn, then saves after read_workflow", async () => {
        const store: WorkflowStore = new Map([
            ["w1", { title: "deal-memo", skill_md: "# Deal memo\n\nNever invent numbers.", name: "deal-memo" }],
        ]);
        const edit = { skill_id: "w1", name: "deal-memo", instructions: "# Deal memo, v2" };

        const refused = await call("save_skill", edit, store);
        expect(JSON.parse(content(refused)).error).toContain('read_workflow (workflow_id "w1")');
        expect(refused.workflowsApplied).toEqual([]);
        expect(runSaveSkill).not.toHaveBeenCalled();

        const read = await call("read_workflow", { workflow_id: "w1" }, store);
        expect(content(read)).toContain("Never invent numbers.");

        const saved = await call("save_skill", edit, store);
        expect(runSaveSkill).toHaveBeenCalledTimes(1);
        expect(saved.workflowsApplied).toEqual([
            { workflow_id: "w1", title: "deal-memo", action: "saved", version_number: 2, call_id: "call-save_skill" },
        ]);
    });

    it("saves a new skill without a read", async () => {
        runSaveSkill.mockResolvedValue({ ok: true, saved: { ...SAVED, skillId: "w9", name: "new-one", title: "new-one", created: true, versionNumber: 1 }, body: "x" });
        const result = await call("save_skill", { name: "new-one", instructions: "x" }, new Map());
        expect(runSaveSkill).toHaveBeenCalledTimes(1);
        expect(JSON.parse(content(result))).toMatchObject({ ok: true, skill_id: "w9" });
    });
});
