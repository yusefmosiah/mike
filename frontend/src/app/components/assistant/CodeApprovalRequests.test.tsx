import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    decideCodeApproval,
    getCodeApprovals,
    revokeCodeApproval,
    type CodeApproval,
} from "@/app/lib/mikeApi";
import { CodeApprovalRequests } from "./CodeApprovalRequests";

vi.mock("@/app/lib/mikeApi", () => ({
    getCodeApprovals: vi.fn(),
    decideCodeApproval: vi.fn(),
    revokeCodeApproval: vi.fn(),
}));

const request = (overrides: Partial<CodeApproval> = {}): CodeApproval => ({
    id: "r1",
    guest_user_id: "assoc",
    guest_name: "Alex Associate",
    guest_email: "alex.associate.with.a.long.address@firm.example",
    summary: "python3 totals.py --matter 2291",
    status: "pending",
    created_at: "2026-10-10T00:00:00Z",
    ...overrides,
});

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

it("asks the thread's starter, and sends their answer", async () => {
    // Pending until the starter answers, however often it is read.
    let answered = false;
    vi.mocked(getCodeApprovals).mockImplementation(async () =>
        answered ? [request({ id: "r1", status: "thread" })] : [request()],
    );
    vi.mocked(decideCodeApproval).mockImplementation(async () => {
        answered = true;
    });
    render(<CodeApprovalRequests chatId="c1" isHost watching />);

    expect(await screen.findByText(/Alex Associate.s message wants to run a command in your workstation/)).toBeTruthy();
    expect(screen.getByText("python3 totals.py --matter 2291")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow for this thread" }));
    await waitFor(() => expect(decideCodeApproval).toHaveBeenCalledWith("c1", "r1", "thread"));
    expect(await screen.findByText(/Alex Associate can run code in your workstation in this thread/)).toBeTruthy();

    vi.mocked(revokeCodeApproval).mockResolvedValue();
    vi.mocked(getCodeApprovals).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(revokeCodeApproval).toHaveBeenCalledWith("c1", "assoc"));
    await waitFor(() => expect(screen.queryByText(/can run code/)).toBeNull());
});

it("never asks anyone but the starter, and polls only while something can change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getCodeApprovals).mockResolvedValue([]);
    const { rerender } = render(<CodeApprovalRequests chatId="c1" isHost={false} watching />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(getCodeApprovals).not.toHaveBeenCalled();

    rerender(<CodeApprovalRequests chatId="c1" isHost watching={false} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(getCodeApprovals).toHaveBeenCalledTimes(1);

    rerender(<CodeApprovalRequests chatId="c1" isHost watching />);
    await act(() => vi.advanceTimersByTimeAsync(6_500));
    expect(vi.mocked(getCodeApprovals).mock.calls.length).toBeGreaterThanOrEqual(3);
});

it("says so when an answer could not be saved", async () => {
    vi.mocked(getCodeApprovals).mockResolvedValue([request()]);
    vi.mocked(decideCodeApproval).mockRejectedValue(new Error("409"));
    render(<CodeApprovalRequests chatId="c1" isHost watching />);
    fireEvent.click(await screen.findByRole("button", { name: "Don’t allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your answer could not be saved. Try again.");
});
