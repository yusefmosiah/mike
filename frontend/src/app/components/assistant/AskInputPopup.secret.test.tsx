import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ store: vi.fn() }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    storeVaultSecret: api.store,
}));

import { AskInputPopup } from "./AskInputPopup";

const SECRET = "glpat-very-secret-token-1234";

const request = (extra: Record<string, unknown> = {}) => ({
    type: "ask_inputs" as const,
    event_id: "ask-1",
    items: [
        {
            id: "cred",
            kind: "secret" as const,
            name: "gitlab",
            purpose: "Push the blog to its repository",
            hosts: ["gitlab.com"],
            injection: { type: "header" as const, name: "PRIVATE-TOKEN" },
            ...extra,
        },
    ],
});

beforeEach(() => {
    api.store.mockReset();
    api.store.mockImplementation(async (input: { name: string }) => ({
        id: "sec_2",
        name: input.name,
        description: "",
        hosts: ["gitlab.com"],
        injection: { type: "header", name: "PRIVATE-TOKEN" },
        writes: "ask",
        hint: "",
        created_at: "",
        updated_at: "",
        last_used_at: null,
    }));
});

describe("AskInputPopup credential requests", () => {
    it("asks only for the value, and answers with the name only", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);

        expect(screen.getByText("Push the blog to its repository")).toBeInTheDocument();
        expect(screen.getByText(/In the PRIVATE-TOKEN header/)).toBeInTheDocument();
        // Nothing to choose: no name, host or auth fields; one secret field.
        expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        const field = screen.getByLabelText("Secret");
        expect(field).toHaveAttribute("type", "password");
        const store = screen.getByRole("button", { name: "Store for gitlab.com" });
        expect(store).toBeDisabled();

        fireEvent.change(field, { target: { value: SECRET } });
        fireEvent.click(store);

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(api.store).toHaveBeenCalledWith(
            {
                name: "gitlab",
                hosts: ["gitlab.com"],
                injection: { type: "header", name: "PRIVATE-TOKEN" },
                writes: "ask",
            },
            SECRET,
            "user-1",
        );
        const [response, content] = onSubmit.mock.calls[0];
        expect(response.responses).toEqual([{ id: "cred", kind: "secret", secret_name: "gitlab" }]);
        // Nothing that reaches the chat carries the value.
        expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain(SECRET);
        expect(content).toContain('Stored the credential in the vault as "gitlab"');
    });

    it("replaces a stored credential when the assistant asks to", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request({ replaces: "sec_1" })} onSubmit={onSubmit} />);
        expect(screen.getByText(/Replaces the stored gitlab/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        fireEvent.submit(screen.getByLabelText("Secret").closest("form")!);
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(api.store.mock.calls[0][0]).toMatchObject({ name: "gitlab", replaces: "sec_1" });
    });

    it("answers as not stored when skipped", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses).toEqual([{ id: "cred", kind: "secret", skipped: true }]);
        expect(api.store).not.toHaveBeenCalled();
    });

    it("keeps the field with the vault's message when storing fails", async () => {
        const { MikeApiError } = await import("@/app/lib/mikeApi");
        api.store.mockRejectedValueOnce(new MikeApiError({ message: "a secret named gitlab already exists", status: 409 }));
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={onSubmit} />);
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        fireEvent.click(screen.getByRole("button", { name: "Store for gitlab.com" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
        expect(screen.getByLabelText("Secret")).toBeInTheDocument();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("says nothing was sent when the vault's key cannot be verified", async () => {
        const { VaultKeyMismatchError } = await import("@/app/lib/vault/seal");
        api.store.mockRejectedValueOnce(new VaultKeyMismatchError());
        render(<AskInputPopup assistantMessageId="m1" event={request()} onSubmit={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        fireEvent.click(screen.getByRole("button", { name: "Store for gitlab.com" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("nothing was sent");
    });
});
