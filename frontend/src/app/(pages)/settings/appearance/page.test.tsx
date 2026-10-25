import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppearancePage from "./page";

const { updateDarkMode, profile } = vi.hoisted(() => ({
    updateDarkMode: vi.fn(),
    profile: { darkMode: false as boolean | null },
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile,
        updateDarkMode,
    }),
}));

describe("AppearancePage", () => {
    beforeEach(() => {
        updateDarkMode.mockReset();
        updateDarkMode.mockResolvedValue(undefined);
        profile.darkMode = false;
    });

    it("offers light, dark and system, without a decorative card icon", async () => {
        const user = userEvent.setup();
        const { container } = render(<AppearancePage />);

        expect(
            screen.getByRole("heading", { name: "Appearance" }),
        ).toBeVisible();
        expect(container.querySelector("svg")).toBeNull();
        expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );

        await user.click(screen.getByRole("button", { name: "Dark" }));
        expect(updateDarkMode).toHaveBeenCalledWith(true);

        await user.click(screen.getByRole("button", { name: "System" }));
        expect(updateDarkMode).toHaveBeenLastCalledWith(null);
    });

    it("shows System as chosen when the profile follows the device", () => {
        profile.darkMode = null;
        render(<AppearancePage />);
        expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
    });

    it("reports a failed change without leaking the raw error", async () => {
        const user = userEvent.setup();
        updateDarkMode.mockRejectedValue(new Error("pg: connection refused"));
        render(<AppearancePage />);

        await user.click(screen.getByRole("button", { name: "Dark" }));
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Could not update the appearance setting.",
            ),
        );
        expect(screen.queryByText(/connection refused/i)).not.toBeInTheDocument();
    });
});
