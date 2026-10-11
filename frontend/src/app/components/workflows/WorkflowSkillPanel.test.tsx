import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@/app/components/shared/types";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { exportSkill, listWorkflowVersions, restoreWorkflowVersion, type WorkflowVersion } from "@/app/lib/mikeApi";
import { WorkflowSkillPanel } from "./WorkflowSkillPanel";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listWorkflowVersions: vi.fn(),
    restoreWorkflowVersion: vi.fn(),
    exportSkill: vi.fn(),
}));
vi.mock("@/app/lib/downloadDocument", () => ({ downloadBlob: vi.fn() }));

const workflow = {
    id: "w1",
    metadata: { title: "pdf", description: "Fill and read PDF forms.", type: "assistant" },
    source_url: "https://github.com/acme/skills/tree/abc123/pdf",
    files: [{ path: "scripts/fill.py", size: 2048 }],
} as unknown as Workflow;

const version = (n: number, source: WorkflowVersion["source"]): WorkflowVersion => ({
    id: `v${n}`,
    version_number: n,
    title: "pdf",
    description: null,
    files: null,
    source,
    source_url: null,
    created_at: "2026-10-10T12:00:00Z",
});

afterEach(() => vi.clearAllMocks());

describe("WorkflowSkillPanel", () => {
    it("shows the description, source, files and versions, and restores an earlier one", async () => {
        vi.mocked(listWorkflowVersions).mockResolvedValue([version(2, "chat"), version(1, "import")]);
        vi.mocked(restoreWorkflowVersion).mockResolvedValue({ version_number: 3 });
        const onRestored = vi.fn();
        render(<WorkflowSkillPanel workflow={workflow} readOnly={false} onRestored={onRestored} />);

        expect(screen.getByText("Fill and read PDF forms.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /github\.com\/acme\/skills/ })).toHaveAttribute("href", workflow.source_url);
        expect(screen.getByText("scripts/fill.py")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "Loading versions" })).toBeInTheDocument();

        expect(await screen.findByText("Version 2 (current)")).toBeInTheDocument();
        expect(screen.getByText("Saved from a chat")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onRestored).toHaveBeenCalled());
        expect(restoreWorkflowVersion).toHaveBeenCalledWith("w1", "v1");
        expect(listWorkflowVersions).toHaveBeenCalledTimes(2);
    });

    it("hides restore when read-only, says when there are no versions, and downloads the folder", async () => {
        vi.mocked(listWorkflowVersions).mockResolvedValue([]);
        vi.mocked(exportSkill).mockResolvedValue({ blob: new Blob(["zip"]), filename: null });
        render(
            <WorkflowSkillPanel
                workflow={{ ...workflow, source_url: null, files: null, metadata: { ...workflow.metadata, description: null } } as Workflow}
                readOnly
                onRestored={vi.fn()}
            />,
        );
        expect(await screen.findByText(/No earlier versions yet/)).toBeInTheDocument();
        expect(screen.getByText(/No description/)).toBeInTheDocument();
        expect(screen.queryByRole("link")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Download skill folder" }));
        await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "skill.zip"));
    });

    it("says so when versions cannot load or a restore or download fails", async () => {
        vi.mocked(listWorkflowVersions).mockRejectedValueOnce(new Error("down"));
        const { unmount } = render(<WorkflowSkillPanel workflow={workflow} readOnly={false} onRestored={vi.fn()} />);
        expect(await screen.findByText("The versions could not be loaded.")).toBeInTheDocument();
        unmount();

        vi.mocked(listWorkflowVersions).mockResolvedValue([version(2, "edit"), version(1, "original")]);
        vi.mocked(restoreWorkflowVersion).mockRejectedValue(new Error("boom"));
        vi.mocked(exportSkill).mockRejectedValue(new Error("boom"));
        render(<WorkflowSkillPanel workflow={workflow} readOnly={false} onRestored={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("That version could not be restored.");
        fireEvent.click(screen.getByRole("button", { name: "Download skill folder" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The skill could not be downloaded."));
    });
});
