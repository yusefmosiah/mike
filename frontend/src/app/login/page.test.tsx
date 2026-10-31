import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const { login, startGoogleOAuth, refreshSession, replace, push } = vi.hoisted(
    () => ({
        login: vi.fn(),
        startGoogleOAuth: vi.fn(),
        refreshSession: vi.fn(),
        replace: vi.fn(),
        push: vi.fn(),
    }),
);

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("@/app/lib/authApi", () => ({
    login,
    startGoogleOAuth,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: false,
        authLoading: false,
        refreshSession,
    }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("LoginPage", () => {
    beforeEach(() => {
        login.mockReset();
        startGoogleOAuth.mockReset();
        refreshSession.mockReset();
        refreshSession.mockResolvedValue(null);
        replace.mockReset();
        push.mockReset();
    });

    it("allows an existing account to submit a password shorter than the new minimum", async () => {
        login.mockResolvedValue({ user: { id: "user-1" } });
        const user = userEvent.setup();
        render(<LoginPage />);

        expect(screen.getByLabelText("Password")).not.toHaveAttribute(
            "placeholder",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "existing@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "oldpass");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        expect(login).toHaveBeenCalledWith("existing@example.com", "oldpass");
        expect(push).toHaveBeenCalledWith("/assistant");
    });

    it("places SSO after the primary login action and hides Google", () => {
        render(<LoginPage />);

        const login = screen.getByRole("button", { name: "Log in" });
        const sso = screen.getByRole("button", { name: "Continue with SSO" });
        expect(
            login.compareDocumentPosition(sso) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Continue with Google" }),
        ).not.toBeInTheDocument();
    });

    it("returns to the page the visitor asked for after signing in", async () => {
        login.mockResolvedValue({ user: { id: "user-1" } });
        window.history.pushState({}, "", "/login?next=%2Fpublished%3Fp%3Dabc%26r%3D%252Fx");
        const user = userEvent.setup();
        render(<LoginPage />);
        await user.type(screen.getByRole("textbox", { name: "Email" }), "a@b.co");
        await user.type(screen.getByLabelText("Password"), "oldpass");
        await user.click(screen.getByRole("button", { name: "Log in" }));
        await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/published?p=abc&r=%2Fx"));
        window.history.pushState({}, "", "/login");
    });
});
