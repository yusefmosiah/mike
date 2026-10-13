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

const event = {
    type: "ask_inputs" as const,
    event_id: "ask-1",
    items: [
        {
            id: "cred",
            kind: "secret" as const,
            name: "blog-deploy",
            purpose: "Push the blog to its repository",
            hosts: ["gitlab.com"],
            injection: { type: "basic" as const, username: "oauth2" },
        },
    ],
};

beforeEach(() => {
    api.store.mockReset();
    api.store.mockImplementation(async (input: { name: string }) => ({
        id: "sec_1",
        name: input.name,
        description: "",
        hosts: ["gitlab.com"],
        injection: { type: "basic", username: "oauth2" },
        writes: "ask",
        hint: "1234",
        created_at: "",
        updated_at: "",
        last_used_at: null,
    }));
});

describe("AskInputPopup credential requests", () => {
    it("stores the value through the vault form and answers with the name only", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={event} onSubmit={onSubmit} />);

        expect(screen.getByText("Push the blog to its repository")).toBeInTheDocument();
        expect(screen.getByText("gitlab.com")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Store in vault…" }));

        // The form starts from the assistant's suggestion.
        expect(screen.getByLabelText("Name")).toHaveValue("blog-deploy");
        expect(screen.getByLabelText("Where it may be sent")).toHaveValue("gitlab.com");
        expect(screen.getByLabelText("Username")).toHaveValue("oauth2");
        const secret = screen.getByLabelText("Secret");
        expect(secret).toHaveAttribute("type", "password");
        fireEvent.change(secret, { target: { value: SECRET } });
        // Hosts the assistant proposed must be confirmed before storing.
        const store = screen.getByRole("button", { name: "Store in vault" });
        expect(store).toBeDisabled();
        fireEvent.click(screen.getByRole("checkbox", { name: /The assistant suggested gitlab\.com/ }));
        fireEvent.click(store);

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(api.store).toHaveBeenCalledWith(
            {
                name: "blog-deploy",
                hosts: ["gitlab.com"],
                injection: { type: "basic", username: "oauth2" },
                writes: "ask",
            },
            SECRET,
            "user-1",
        );
        const [response, content] = onSubmit.mock.calls[0];
        expect(response.responses).toEqual([
            { id: "cred", kind: "secret", secret_name: "blog-deploy" },
        ]);
        // Nothing that reaches the chat carries the value.
        expect(JSON.stringify(onSubmit.mock.calls[0])).not.toContain(SECRET);
        expect(content).toContain('Stored the credential in the vault as "blog-deploy"');
    });

    it("needs no confirmation for hosts the user typed", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={event} onSubmit={onSubmit} />);
        fireEvent.click(screen.getByRole("button", { name: "Store in vault…" }));
        fireEvent.change(screen.getByLabelText("Where it may be sent"), { target: { value: "gitlab.example.org" } });
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        expect(screen.queryByRole("checkbox", { name: /The assistant suggested/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Store in vault" }));
        await waitFor(() => expect(api.store).toHaveBeenCalledTimes(1));
        expect(api.store.mock.calls[0][0].hosts).toEqual(["gitlab.example.org"]);
    });

    it("says nothing was sent when the vault's key cannot be verified", async () => {
        const { VaultKeyMismatchError } = await import("@/app/lib/vault/seal");
        api.store.mockRejectedValueOnce(new VaultKeyMismatchError());
        render(<AskInputPopup assistantMessageId="m1" event={event} onSubmit={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Store in vault…" }));
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        fireEvent.click(screen.getByRole("checkbox", { name: /The assistant suggested/ }));
        fireEvent.click(screen.getByRole("button", { name: "Store in vault" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("nothing was sent");
    });

    it("answers as not stored when skipped", async () => {
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={event} onSubmit={onSubmit} />);
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses).toEqual([
            { id: "cred", kind: "secret", skipped: true },
        ]);
        expect(api.store).not.toHaveBeenCalled();
    });

    it("keeps the form open with the vault's message when storing fails", async () => {
        const { MikeApiError } = await import("@/app/lib/mikeApi");
        api.store.mockRejectedValueOnce(
            new MikeApiError({ message: "a secret named blog-deploy already exists", status: 409 }),
        );
        const onSubmit = vi.fn();
        render(<AskInputPopup assistantMessageId="m1" event={event} onSubmit={onSubmit} />);
        fireEvent.click(screen.getByRole("button", { name: "Store in vault…" }));
        fireEvent.change(screen.getByLabelText("Secret"), { target: { value: SECRET } });
        fireEvent.click(screen.getByRole("checkbox", { name: /The assistant suggested/ }));
        fireEvent.click(screen.getByRole("button", { name: "Store in vault" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
        expect(onSubmit).not.toHaveBeenCalled();
    });
});
