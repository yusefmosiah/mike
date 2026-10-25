import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "" }));
const api = vi.hoisted(() => ({ openPublication: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));

import { MikeApiError } from "@/app/lib/mikeApi";
import PublishedPage from "./page";

const ID = "2f1c0c7e-6a4c-4a57-9d59-0d2f6a1e8b11";
const replace = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "location", { value: { replace }, configurable: true });
});

describe("PublishedPage", () => {
    it("opens the link and goes to the address it returns", async () => {
        nav.search = `p=${ID}&r=%2Fimg%2Fa.png`;
        let resolve!: (v: { url: string }) => void;
        api.openPublication.mockReturnValue(new Promise((r) => (resolve = r)));
        render(<PublishedPage />);
        expect(screen.getByRole("status")).toHaveTextContent("Opening");
        resolve({ url: "https://c.example/x" });
        await waitFor(() => expect(replace).toHaveBeenCalledWith("https://c.example/x"));
        expect(api.openPublication).toHaveBeenCalledWith(ID, "/img/a.png");
    });

    it("opens the publication's start page when no path is given", async () => {
        nav.search = `p=${ID}`;
        api.openPublication.mockResolvedValue({ url: "https://c.example/" });
        render(<PublishedPage />);
        await waitFor(() => expect(replace).toHaveBeenCalled());
        expect(api.openPublication).toHaveBeenCalledWith(ID, undefined);
    });

    it("says the page is not available to this account on a 404", async () => {
        nav.search = `p=${ID}`;
        api.openPublication.mockRejectedValue(new MikeApiError({ status: 404, code: "not_found", message: "x" }));
        render(<PublishedPage />);
        expect(await screen.findByText(/isn't available to this account/)).toBeInTheDocument();
        expect(screen.getByText(/different account/)).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it("falls back to a generic message on any other error, never the raw detail", async () => {
        nav.search = `p=${ID}`;
        api.openPublication.mockRejectedValue(new Error("db exploded"));
        render(<PublishedPage />);
        expect(await screen.findByText("The page could not be opened. Please try again.")).toBeInTheDocument();
        expect(screen.queryByText(/exploded/)).toBeNull();
    });

    it.each(["", "p=not-a-uuid", `p=${ID}x`])("does not call the API for a malformed link (%s)", (search) => {
        nav.search = search;
        render(<PublishedPage />);
        expect(screen.getByText(/isn't available to this account/)).toBeInTheDocument();
        expect(api.openPublication).not.toHaveBeenCalled();
    });

    it("ignores an answer that arrives after leaving", async () => {
        nav.search = `p=${ID}`;
        let resolve!: (v: { url: string }) => void;
        let reject!: (e: unknown) => void;
        api.openPublication
            .mockReturnValueOnce(new Promise((r) => (resolve = r)))
            .mockReturnValueOnce(new Promise((_, r) => (reject = r)));
        render(<PublishedPage />).unmount();
        resolve({ url: "https://c.example/late" });
        render(<PublishedPage />).unmount();
        reject(new Error("late"));
        await Promise.resolve();
        expect(replace).not.toHaveBeenCalled();
    });
});
