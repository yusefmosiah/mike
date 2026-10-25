import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import type { Publication } from "@/app/components/shared/types";
import { PublishModal } from "./PublishModal";

const api = vi.hoisted(() => ({
    createPublication: vi.fn(),
    listPublications: vi.fn(),
    revokePublication: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));

const pub = (over: Partial<Publication> = {}): Publication => ({
    id: "p1", document_id: "d1", version_id: "v1", title: "T", kind: "file", audience: "public",
    url: "https://pub.example/p1", created_at: "2026-01-02T12:00:00Z", expires_at: null, revoked_at: null,
    file_count: 1, require_sign_in: false, ...over,
});

const target = { documentId: "d1", versionId: "v1", filename: "plan.html" };
const both = { enabled: true, audiences: ["public", "password"] as ("public" | "password")[] };
const writeText = vi.fn();

function open(config = both, onClose = vi.fn()) {
    render(<PublishModal open target={target} config={config} onClose={onClose} />);
    return onClose;
}

beforeEach(() => {
    vi.clearAllMocks();
    api.listPublications.mockResolvedValue([]);
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("PublishModal", () => {
    it("renders nothing while closed", () => {
        render(<PublishModal open={false} target={target} config={both} onClose={vi.fn()} />);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("publishes a public link for 30 days by default and offers to copy it", async () => {
        api.createPublication.mockResolvedValue({ publication: pub(), missing_files: [] });
        open();
        expect(screen.getByText(/frozen copy/)).toBeInTheDocument();
        expect(screen.getByText(/Anyone who has a public link/)).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "Loading links" })).toBeInTheDocument();
        await screen.findByText("No links yet.");

        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        expect(api.createPublication).toHaveBeenCalledWith({
            document_id: "d1", version_id: "v1", audience: "public", expires_in_days: 30,
        });
        const section = await screen.findByRole("region", { name: "Published link" });
        expect(within(section).getByText("https://pub.example/p1")).toBeInTheDocument();
        expect(within(section).queryByRole("button", { name: "Copy password" })).toBeNull();
        await userEvent.click(within(section).getByRole("button", { name: "Copy link" }));
        expect(writeText).toHaveBeenCalledWith("https://pub.example/p1");
        await screen.findByText("Copied");
        // Also listed among the document's links.
        expect(within(screen.getByRole("region", { name: "Existing links" })).getByText("Created Jan 2, 2026 · Never expires")).toBeInTheDocument();
    });

    it("sends a password link with a generated passphrase and the chosen expiry", async () => {
        api.createPublication.mockResolvedValue({ publication: pub({ audience: "password" }), missing_files: ["img/a.png"] });
        open();
        await userEvent.click(screen.getByRole("button", { name: /and a password/ }));
        const publish = screen.getByRole("button", { name: "Publish" });
        expect(publish).toBeDisabled();
        await userEvent.type(screen.getByLabelText("Password"), "short");
        expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
        expect(publish).toBeDisabled();
        await userEvent.click(screen.getByRole("button", { name: "Generate" }));
        const password = (screen.getByLabelText("Password") as HTMLInputElement).value;
        expect(password.length).toBeGreaterThanOrEqual(12);
        expect(screen.getByText(/Send the password separately/)).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Never" }));
        await userEvent.click(publish);
        expect(api.createPublication).toHaveBeenCalledWith({
            document_id: "d1", version_id: "v1", audience: "password", password, expires_in_days: null,
        });
        const section = await screen.findByRole("region", { name: "Published link" });
        await userEvent.click(within(section).getByRole("button", { name: "Copy password" }));
        expect(writeText).toHaveBeenCalledWith(password);
        expect(within(section).getByRole("status")).toHaveTextContent("img/a.png");
    });

    it("offers only the audiences the install allows", () => {
        open({ enabled: true, audiences: ["password"] });
        expect(screen.queryByRole("button", { name: "Anyone with the link" })).toBeNull();
        expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    it("falls back to a public default when no audience is listed", () => {
        open({ enabled: true, audiences: [] });
        expect(screen.getByText(/Anyone who has a public link/)).toBeInTheDocument();
    });

    it("shows an intentional message when publishing fails, never the raw detail", async () => {
        api.createPublication.mockRejectedValue(
            new MikeApiError({ status: 400, code: "no_rendition", message: "internal detail" }),
        );
        open();
        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("not ready yet");
        expect(alert).not.toHaveTextContent("internal detail");
    });

    it("reports a failed copy and a failed listing", async () => {
        api.listPublications.mockRejectedValue(new Error("x"));
        writeText.mockRejectedValue(new Error("denied"));
        api.createPublication.mockResolvedValue({ publication: pub(), missing_files: [] });
        open();
        expect(await screen.findByText("Existing links could not be loaded.")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
        await screen.findByText("Copy failed");
    });

    it("lists earlier links with their state, long URLs wrapping, and opens them safely", async () => {
        const long = "https://pub.example/" + "x".repeat(120);
        api.listPublications.mockResolvedValue([
            pub({ id: "a", url: long, expires_at: "2099-06-15T12:00:00Z", audience: "password" }),
            pub({ id: "b", url: null, revoked_at: "2026-01-03T00:00:00Z" }),
            pub({ id: "c", expires_at: "2026-01-05T00:00:00Z" }),
        ]);
        open();
        const list = await screen.findByRole("region", { name: "Existing links" });
        expect(within(list).getByText(long).className).toContain("[overflow-wrap:anywhere]");
        expect(within(list).getByText(/Created Jan 2, 2026 · Revoked/)).toBeInTheDocument();
        expect(within(list).getByText(/Created Jan 2, 2026 · Expired/)).toBeInTheDocument();
        expect(within(list).getByText(/Expires Jun 15, 2099/)).toBeInTheDocument();
        // Revoked and expired links no longer open, so they offer no link.
        const links = within(list).getAllByRole("link", { name: "Open" });
        expect(links).toHaveLength(1);
        expect(links[0]).toHaveAttribute("target", "_blank");
        expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
        // Only the live link can be revoked.
        expect(within(list).getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    });

    it("revokes a link only after confirmation, and clears the just-published banner", async () => {
        api.createPublication.mockResolvedValue({ publication: pub(), missing_files: [] });
        api.revokePublication.mockResolvedValue(pub({ revoked_at: "2026-01-04T00:00:00Z" }));
        open();
        await screen.findByText("No links yet.");
        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        await screen.findByRole("region", { name: "Published link" });

        await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
        const dialog = screen.getByRole("dialog", { name: "Revoke this link?" });
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(api.revokePublication).not.toHaveBeenCalled();

        await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
        await userEvent.click(within(screen.getByRole("dialog", { name: "Revoke this link?" })).getByRole("button", { name: "Revoke" }));
        await waitFor(() => expect(api.revokePublication).toHaveBeenCalledWith("p1"));
        await waitFor(() => expect(screen.queryByRole("region", { name: "Published link" })).toBeNull());
        expect(screen.getByText(/· Revoked/)).toBeInTheDocument();
    });

    it("keeps an unrelated published banner when another link is revoked, and reports a failed revoke", async () => {
        api.listPublications.mockResolvedValue([pub({ id: "old" })]);
        api.createPublication.mockResolvedValue({ publication: pub({ id: "new", url: "https://pub.example/new" }), missing_files: [] });
        api.revokePublication.mockResolvedValueOnce(pub({ id: "old", revoked_at: "2026-01-04T00:00:00Z" }));
        open();
        await screen.findByText("https://pub.example/p1");
        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        await screen.findByRole("region", { name: "Published link" });
        const oldRow = screen.getByText("https://pub.example/p1").closest("li")!;
        await userEvent.click(within(oldRow).getByRole("button", { name: "Revoke" }));
        await userEvent.click(within(screen.getByRole("dialog", { name: "Revoke this link?" })).getByRole("button", { name: "Revoke" }));
        await waitFor(() => expect(within(oldRow).queryByRole("button", { name: "Revoke" })).toBeNull());
        expect(screen.getByRole("region", { name: "Published link" })).toBeInTheDocument();

        api.revokePublication.mockRejectedValueOnce(new Error("boom"));
        const newRow = screen.getAllByText("https://pub.example/new")[1]!.closest("li")!;
        await userEvent.click(within(newRow).getByRole("button", { name: "Revoke" }));
        await userEvent.click(within(screen.getByRole("dialog", { name: "Revoke this link?" })).getByRole("button", { name: "Revoke" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("could not be revoked");
    });

    it("closes", async () => {
        const onClose = open();
        await userEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("ignores a listing that finishes after it is closed", async () => {
        let resolve!: (v: Publication[]) => void;
        api.listPublications.mockReturnValue(new Promise((r) => (resolve = r)));
        const { unmount } = render(<PublishModal open target={target} config={both} onClose={vi.fn()} />);
        unmount();
        resolve([]);
        await Promise.resolve();
        fireEvent.keyDown(document, { key: "Escape" });
    });

    it("ignores a failed listing that finishes after it is closed", async () => {
        let reject!: (e: Error) => void;
        api.listPublications.mockReturnValue(new Promise((_, r) => (reject = r)));
        const { unmount } = render(<PublishModal open target={target} config={both} onClose={vi.fn()} />);
        unmount();
        reject(new Error("x"));
        await Promise.resolve();
    });
});

describe("PublishModal signed-in-only links", () => {
    it("sends require_sign_in when the toggle is on and explains it", async () => {
        api.createPublication.mockResolvedValue({ publication: pub({ require_sign_in: true }), missing_files: [] });
        open();
        const toggle = screen.getByRole("switch", { name: /signed in who can open this document/ });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(screen.getByText(/asked to sign in/)).toBeInTheDocument();
        await userEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(screen.getByText(/Only people signed in to this app/)).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Publish" }));
        expect(api.createPublication).toHaveBeenCalledWith({
            document_id: "d1", version_id: "v1", audience: "public", require_sign_in: true, expires_in_days: 30,
        });
        await screen.findByRole("region", { name: "Published link" });
        expect(within(screen.getByRole("region", { name: "Existing links" })).getByText("Signed in only")).toBeInTheDocument();
    });

    it("lists signed-in-only links as plain text", async () => {
        api.listPublications.mockResolvedValue([pub({ require_sign_in: true }), pub({ id: "q" })]);
        open();
        const list = await screen.findByRole("region", { name: "Existing links" });
        expect(within(list).getAllByText("Signed in only")).toHaveLength(1);
    });
});
