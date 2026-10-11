import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { listDocumentVersions, replaceDocumentVersionFile } from "@/app/lib/mikeApi";
import { splitFrontMatter, TextView } from "./TextView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    API_BASE: "/api",
    MikeApiError: class MikeApiError extends Error {},
    listDocumentVersions: vi.fn(),
    replaceDocumentVersionFile: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const respond = (...bodies: Array<string | number>) => {
    for (const body of bodies) {
        vi.mocked(authenticatedFetch).mockResolvedValueOnce(
            typeof body === "number" ? new Response("", { status: body }) : new Response(body, { status: 200 }),
        );
    }
};

async function hex(text: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("TextView", () => {
    it("renders Markdown at the version asked for, with its front matter as details", async () => {
        respond('---\nsource: "https://example.com/v"\nmethod: api\n---\n\n# Notes\n\n- **one**');
        render(<TextView documentId="d1" versionId="v2" filename="notes.md" />);

        expect(screen.getByRole("status", { name: "Loading document" })).toBeInTheDocument();
        const article = await screen.findByRole("article", { name: "notes.md" });
        expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
        expect(article.querySelector("strong")?.textContent).toBe("one");
        expect(article.textContent).not.toContain("---");
        expect(screen.getByText("source")).toBeInTheDocument();
        expect(screen.getByText("https://example.com/v")).toBeInTheDocument();
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file?version_id=v2");
        // Nothing to edit with unless the reader may.
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    });

    it("shows other text as written", async () => {
        respond("# not a heading in a .txt");
        render(<TextView documentId="d1" filename="a.txt" rounded={false} />);
        const text = await screen.findByLabelText("a.txt");
        expect(text.tagName).toBe("PRE");
        expect(text.textContent).toBe("# not a heading in a .txt");
    });

    it("says so when the text cannot be loaded", async () => {
        respond(404);
        render(<TextView documentId="d1" filename="notes.md" rounded="top-right" />);

        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
        expect(vi.mocked(authenticatedFetch).mock.calls[0]![0]).toBe("/api/single-documents/d1/file");
    });

    it("loads again for a new version", async () => {
        respond("first", "second");
        const { rerender } = render(<TextView documentId="d1" versionId="v1" filename="a.txt" rounded={false} />);
        expect((await screen.findByLabelText("a.txt")).textContent).toBe("first");
        rerender(<TextView documentId="d1" versionId="v2" filename="a.txt" rounded={false} />);
        await waitFor(() => expect(screen.getByLabelText("a.txt").textContent).toBe("second"));
    });

    it("edits the source as plain text and saves it over the version shown", async () => {
        respond("# Title\n\nBody");
        vi.mocked(replaceDocumentVersionFile).mockResolvedValue({} as never);
        render(<TextView documentId="d1" versionId="v3" filename="notes.md" canEdit />);

        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        const source = screen.getByRole("textbox", { name: "notes.md source" });
        expect(source).toHaveValue("# Title\n\nBody");
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

        fireEvent.change(source, { target: { value: "# Title\n\nNew body" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByRole("article", { name: "notes.md" });
        expect(screen.getByText("New body")).toBeInTheDocument();
        const [documentId, versionId, file, , options] = vi.mocked(replaceDocumentVersionFile).mock.calls[0]!;
        expect([documentId, versionId]).toEqual(["d1", "v3"]);
        expect((file as File).type).toBe("text/markdown");
        expect(await (file as File).text()).toBe("# Title\n\nNew body");
        expect(options).toEqual({ expectedContentSha256: await hex("# Title\n\nBody"), generatePdf: false });
        expect(listDocumentVersions).not.toHaveBeenCalled();
    });

    it("saves over the current version when none is chosen, and cancels without saving", async () => {
        respond("plain");
        vi.mocked(listDocumentVersions).mockResolvedValue({ current_version_id: "v9", versions: [] });
        vi.mocked(replaceDocumentVersionFile).mockResolvedValue({} as never);
        render(<TextView documentId="d1" filename="a.txt" canEdit />);

        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByLabelText("a.txt").textContent).toBe("plain");

        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "plainer" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.getByLabelText("a.txt").textContent).toBe("plainer"));
        const [, versionId, file] = vi.mocked(replaceDocumentVersionFile).mock.calls[0]!;
        expect(versionId).toBe("v9");
        expect((file as File).type).toBe("text/plain");
    });

    it("keeps the edit and explains when saving fails or there is no version", async () => {
        respond("text", "text");
        vi.mocked(replaceDocumentVersionFile).mockRejectedValueOnce(new Error("internal detail"));
        const { unmount } = render(<TextView documentId="d1" versionId="v1" filename="a.txt" canEdit />);

        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
        expect(screen.getByRole("alert")).not.toHaveTextContent("internal detail");
        expect(screen.getByRole("textbox")).toHaveValue("changed");
        unmount();

        vi.mocked(listDocumentVersions).mockResolvedValue({ current_version_id: null, versions: [] });
        render(<TextView documentId="d1" filename="a.txt" canEdit />);
        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
        expect(replaceDocumentVersionFile).toHaveBeenCalledTimes(1);
    });

    it("drops an unsaved edit when another version opens", async () => {
        respond("first", "second");
        const { rerender } = render(<TextView documentId="d1" versionId="v1" filename="a.txt" canEdit />);
        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        rerender(<TextView documentId="d1" versionId="v2" filename="a.txt" canEdit />);
        await waitFor(() => expect(screen.getByLabelText("a.txt").textContent).toBe("second"));
        expect(screen.queryByRole("textbox")).toBeNull();
    });
});

describe("splitFrontMatter", () => {
    it("reads key/value lines at the very top and leaves other text alone", () => {
        expect(splitFrontMatter("---\r\ntitle: 'A'\r\nnot a field\r\n---\r\nBody")).toEqual({
            fields: [["title", "A"]],
            body: "Body",
        });
        expect(splitFrontMatter("Body\n---\nx: y\n---")).toEqual({ fields: [], body: "Body\n---\nx: y\n---" });
        expect(splitFrontMatter("---\nx: y\n---")).toEqual({ fields: [["x", "y"]], body: "" });
    });
});
