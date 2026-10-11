import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importSkillFromUrl, importSkillZip, MikeApiError } from "@/app/lib/mikeApi";
import { ImportSkillModal } from "./ImportSkillModal";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    importSkillFromUrl: vi.fn(),
    importSkillZip: vi.fn(),
}));

const imported = { id: "w1", name: "pdf", title: "pdf", version_number: 1, created: true, source_url: null };

afterEach(() => vi.clearAllMocks());

describe("ImportSkillModal", () => {
    it("imports from a GitHub link", async () => {
        vi.mocked(importSkillFromUrl).mockResolvedValue(imported);
        const onImported = vi.fn();
        render(<ImportSkillModal open onClose={vi.fn()} onImported={onImported} />);

        const importButton = screen.getByRole("button", { name: "Import" });
        expect(importButton).toBeDisabled();
        fireEvent.change(screen.getByLabelText("GitHub link"), {
            target: { value: " https://github.com/a/b/tree/main/pdf " },
        });
        fireEvent.click(importButton);

        await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported));
        expect(importSkillFromUrl).toHaveBeenCalledWith("https://github.com/a/b/tree/main/pdf");
    });

    it("imports a zip, and shows why an import was refused", async () => {
        vi.mocked(importSkillZip).mockRejectedValue(
            new MikeApiError({ status: 400, code: "invalid_skill", requestId: null, message: "A skill needs a SKILL.md at the top of its folder." }),
        );
        render(<ImportSkillModal open onClose={vi.fn()} onImported={vi.fn()} />);

        const zip = new File(["PK"], "my-skill.zip", { type: "application/zip" });
        fireEvent.change(document.getElementById("import-skill-file")!, { target: { files: [zip] } });
        expect(screen.getByText("my-skill.zip")).toBeInTheDocument();
        expect(screen.getByLabelText("GitHub link")).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Import" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("A skill needs a SKILL.md at the top of its folder.");
        expect(importSkillZip).toHaveBeenCalledWith(zip);
        expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    });

    it("renders nothing while closed", () => {
        const { container } = render(<ImportSkillModal open={false} onClose={vi.fn()} onImported={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });
});
