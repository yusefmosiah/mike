import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MikeLayout from "./layout";

const navigation = vi.hoisted(() => ({ pathname: "/published", push: vi.fn() }));
vi.mock("next/navigation", () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({ push: navigation.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    ChatHistoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/components/shared/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/app/components/shared/FullScreenLoader", () => ({ FullScreenLoader: () => null }));

const ID = "2f1c0c7e-6a4c-4a57-9d59-0d2f6a1e8b11";

beforeEach(() => {
    navigation.push.mockReset();
});

describe("signed-out visitors", () => {
    it("are sent to login and brought back to the exact page, with its query", () => {
        navigation.pathname = "/published";
        window.history.pushState({}, "", `/published?p=${ID}&r=%2Fa%2Fb.html`);
        render(<MikeLayout><div>Page</div></MikeLayout>);
        const target = new URL(navigation.push.mock.calls[0][0], "http://x");
        expect(target.pathname).toBe("/login");
        expect(target.searchParams.get("next")).toBe(`/published?p=${ID}&r=%2Fa%2Fb.html`);
    });

    it("go to a plain login from other pages", () => {
        navigation.pathname = "/projects/p1";
        window.history.pushState({}, "", "/projects/p1");
        render(<MikeLayout><div>Page</div></MikeLayout>);
        expect(navigation.push).toHaveBeenCalledWith("/login");
    });
});
