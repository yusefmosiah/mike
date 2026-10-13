import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    status: vi.fn(),
    secrets: vi.fn(),
    activity: vi.fn(),
    workstation: vi.fn(),
    allow: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getVaultStatus: api.status,
    listVaultSecrets: api.secrets,
    listVaultActivity: api.activity,
    getVaultWorkstation: api.workstation,
    allowVaultWorkstation: api.allow,
}));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));

import VaultSettingsPage from "./page";

beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue({ enabled: true });
    api.secrets.mockResolvedValue([]);
    api.activity.mockResolvedValue([]);
    api.workstation.mockResolvedValue(null);
});

describe("Vault settings", () => {
    it("says when credentials are paused in the workstation, and allows them again", async () => {
        api.workstation
            .mockResolvedValueOnce({ paused_since: "2026-10-13T10:00:00Z", guest_working: false })
            .mockResolvedValueOnce({ paused_since: null, guest_working: false });
        api.allow.mockResolvedValue({ paused_since: null, guest_working: false });
        render(<VaultSettingsPage />);
        expect(await screen.findByText("Paused in your workstation")).toBeInTheDocument();
        expect(screen.getByText(/Someone else worked in your workstation/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
        await waitFor(() => expect(api.allow).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByText("Paused in your workstation")).not.toBeInTheDocument());
    });

    it("cannot be allowed again while someone is working there", async () => {
        api.workstation.mockResolvedValue({ paused_since: "2026-10-13T10:00:00Z", guest_working: true });
        render(<VaultSettingsPage />);
        expect(await screen.findByText(/Someone else is working in your workstation right now/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Allow again" })).toBeDisabled();
    });

    it("still lists secrets when the workstation state cannot be read", async () => {
        api.workstation.mockRejectedValue(new Error("down"));
        render(<VaultSettingsPage />);
        expect(await screen.findByText(/No secrets stored/)).toBeInTheDocument();
        expect(screen.queryByText("Paused in your workstation")).not.toBeInTheDocument();
    });
});
