import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ createPublication: vi.fn(), getPublishingConfig: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));

import { MikeApiError } from "@/app/lib/mikeApi";
import { AskInputPopup } from "./AskInputPopup";

const PASSWORD = "river-cedar-maple-otter";

const item = (extra: Record<string, unknown> = {}) => ({
    id: "pub",
    kind: "publish" as const,
    document_id: "d1",
    version_id: "v1",
    filename: "plan.html",
    audience: "public" as const,
    require_sign_in: false,
    expires_in_days: 30,
    purpose: "Share the plan with the client <b>now</b>",
    ...extra,
});
const request = (extra: Record<string, unknown> = {}) => ({
    type: "ask_inputs" as const,
    event_id: "ask-1",
    items: [item(extra)],
});
const publication = (over: Record<string, unknown> = {}) => ({
    id: "pub-1", document_id: "d1", version_id: "v1", title: "T", kind: "file", audience: "public",
    require_sign_in: false, url: "https://pub.example/pub-1", created_at: "2026-01-02T00:00:00Z",
    expires_at: null, revoked_at: null, file_count: 1, ...over,
});
const writeText = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    api.getPublishingConfig.mockResolvedValue({ enabled: true, audiences: ["public", "password"] });
    api.createPublication.mockResolvedValue({ publication: publication(), missing_files: [] });
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("AskInputPopup publish requests", () => {
    it("shows the filename, not the agent's reason, with the suggestions filled in", async () => {
        render(<AskInputPopup assistantMessageId="m1" event={request({ require_sign_in: true, expires_in_days: 7 })} onSubmit={vi.fn()} />);
        expect(screen.getByRole("status", { name: "Loading publishing options" })).toBeInTheDocument();
        expect(await screen.findByRole("switch")).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
        expect(screen.getByText("plan.html")).toBeInTheDocument();
        expect(screen.queryByText(/Share the plan/)).toBeNull();
        expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    });

    it("publishes with the chosen options and reports only the publication id", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request({ audience: "password" })} onSubmit={onSubmit} />);
        const password = await screen.findByLabelText("Password");
        // The password is required before it can be published.
        const submit = screen.getByRole("button", { name: "Publish" });
        expect(submit).toBeDisabled();
        await userEvent.type(password, PASSWORD);
        await userEvent.click(screen.getByRole("switch"));
        await userEvent.click(screen.getByRole("button", { name: "Never" }));
        await userEvent.click(submit);

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(api.createPublication).toHaveBeenCalledWith({
            document_id: "d1", version_id: "v1", audience: "password", password: PASSWORD,
            require_sign_in: true, expires_in_days: null,
        });
        const [response, content] = onSubmit.mock.calls[0];
        expect(response.responses).toEqual([{ id: "pub", kind: "publish", publication_id: "pub-1" }]);
        expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain(PASSWORD);
        expect(content).toContain('Published "plan.html" as a link (publication pub-1)');

        // The link stays on screen with Copy buttons, including the password.
        const section = screen.getByRole("region", { name: "Published link" });
        expect(section).toHaveTextContent("https://pub.example/pub-1");
        await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
        expect(writeText).toHaveBeenCalledWith("https://pub.example/pub-1");
        await userEvent.click(screen.getByRole("button", { name: "Copy password" }));
        expect(writeText).toHaveBeenCalledWith(PASSWORD);
    });

    it("offers no password copy for a public link", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);
        await screen.findByRole("switch");
        fireEvent.submit(screen.getByRole("switch").closest("form")!);
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("button", { name: "Copy password" })).toBeNull();
        expect(api.createPublication).toHaveBeenCalledWith({
            document_id: "d1", version_id: "v1", audience: "public", expires_in_days: 30,
        });
    });

    it("answers as not published when the person declines", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);
        await screen.findByRole("switch");
        fireEvent.click(screen.getByRole("button", { name: "Don't publish" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses).toEqual([{ id: "pub", kind: "publish", skipped: true }]);
        expect(onSubmit.mock.calls[0][1]).toContain('Did not publish "plan.html"');
        expect(api.createPublication).not.toHaveBeenCalled();
    });

    it("keeps the form with an intentional message when publishing fails", async () => {
        api.createPublication.mockRejectedValueOnce(new MikeApiError({ status: 400, code: "no_rendition", message: "internal detail" }));
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);
        await screen.findByRole("switch");
        fireEvent.submit(screen.getByRole("switch").closest("form")!);
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("not ready yet");
        expect(alert).not.toHaveTextContent("internal detail");
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByRole("switch")).toBeInTheDocument();
    });

    it("says so, and can still be declined, when publishing is off or unreachable", async () => {
        api.getPublishingConfig.mockResolvedValueOnce({ enabled: false, audiences: [] });
        const first = render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={vi.fn()} />);
        expect(await screen.findByText("Publishing is not available right now.")).toBeInTheDocument();
        expect(screen.queryByRole("switch")).toBeNull();
        first.unmount();

        api.getPublishingConfig.mockRejectedValueOnce(new Error("down"));
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={vi.fn()} />);
        expect(await screen.findByText("Publishing is not available right now.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Don't publish" })).toBeInTheDocument();
    });

    it("ignores a config that arrives after it is gone", async () => {
        let resolve!: (v: unknown) => void;
        api.getPublishingConfig.mockReturnValueOnce(new Promise((r) => (resolve = r)));
        const { unmount } = render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={vi.fn()} />);
        unmount();
        resolve({ enabled: true, audiences: ["public"] });
        await Promise.resolve();

        let reject!: (e: unknown) => void;
        api.getPublishingConfig.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
        const second = render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={vi.fn()} />);
        second.unmount();
        reject(new Error("late"));
        await Promise.resolve();
    });

    it("waits for the rest of the questions before answering, then reports both", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="m1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [item(), { id: "q", kind: "text", question: "Which client?" }],
                }}
                onSubmit={onSubmit}
            />,
        );
        await screen.findByRole("switch");
        fireEvent.submit(screen.getByRole("switch").closest("form")!);
        await waitFor(() => expect(api.createPublication).toHaveBeenCalled());
        expect(onSubmit).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Publish link" }));
        expect(await screen.findByRole("region", { name: "Published link" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Question" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Acme" } });
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses).toEqual([
            { id: "pub", kind: "publish", publication_id: "pub-1" },
            { id: "q", kind: "text", question: "Which client?", answer: "Acme" },
        ]);
    });
});
