import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CodeApprovalBlock, codeApprovalText } from "./CodeApprovalBlock";

const event = (status: "waiting" | "allowed" | "denied" | "expired", host_name: string | null = "Pat Partner") => ({
    type: "code_approval" as const,
    call_id: "c1",
    status,
    host_name,
    summary: "ls",
});

it("tells the guest whom the turn is waiting for, then the answer", () => {
    render(<CodeApprovalBlock event={event("waiting")} />);
    expect(screen.getByRole("status").textContent).toContain("Waiting for Pat Partner to allow running code in their workstation…");
    expect(codeApprovalText(event("allowed"))).toBe("Pat Partner allowed running code in their workstation");
    expect(codeApprovalText(event("denied"))).toBe("Pat Partner did not allow running code in their workstation");
    expect(codeApprovalText(event("expired", null))).toBe("The person who started this thread did not answer the request to run code");
});
