import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentCitationCheck } from "@/app/lib/mikeApi";
import { useDocumentCitationChecks, type CitationCheckState } from "@/app/hooks/useDocumentCitationChecks";
import { CitationCheckStatus, summarizeChecks } from "./CitationCheckStatus";

vi.mock("@/app/hooks/useDocumentCitationChecks", () => ({ useDocumentCitationChecks: vi.fn() }));

const check = (ref: number, verdict: DocumentCitationCheck["verdict"], extra: Partial<DocumentCitationCheck> = {}): DocumentCitationCheck => ({
    id: `c${ref}`,
    citation_ref: ref,
    citation_text: `Citation ${ref}`,
    cited_block_id: null,
    proposition: null,
    quote: null,
    verdict,
    reason: null,
    support_reason: null,
    excerpt: null,
    ...extra,
});
const done = (checks: DocumentCitationCheck[], versionId = "v2"): CitationCheckState => ({
    status: "done",
    data: {
        task: { id: "t", document_version_id: versionId, status: "completed", created_at: "", finished_at: "" },
        checks,
        current_version_id: "v2",
    },
});
const show = (state: CitationCheckState) => {
    vi.mocked(useDocumentCitationChecks).mockReturnValue(state);
    return render(<CitationCheckStatus documentId="doc" versionId="v2" />);
};

describe("CitationCheckStatus", () => {
    it("says it is checking while the check runs, and nothing when there is no check", () => {
        const { unmount } = show({ status: "checking", data: { task: null, checks: [], current_version_id: "v2", auto_pending: true } });
        expect(screen.getByRole("status")).toHaveTextContent("Checking citations…");
        unmount();
        const { container } = show({ status: "idle" });
        expect(container).toBeEmptyDOMElement();
    });

    it("reports a clean check", () => {
        show(done([check(1, "exists-and-matches"), check(2, "exists-and-matches")]));
        expect(screen.getByRole("status")).toHaveTextContent("Citations checked · 2 citations verified");
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("lists flagged citations most serious first when opened", () => {
        show(
            done([
                check(1, "exists-and-matches"),
                check(2, "quote-mismatch"),
                check(3, "contradicted", { support_reason: "The court held the opposite.", excerpt: "inherently unequal" }),
                check(4, "unverifiable"),
            ]),
        );
        const toggle = screen.getByRole("button", { name: /Citations checked\s?· 2 of 4 need attention · 1 could not be checked/ });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(toggle);
        const items = screen.getAllByRole("listitem");
        expect(items[0]).toHaveTextContent("Says the opposite · Citation 3");
        expect(items[0]).toHaveTextContent("The court held the opposite.");
        expect(items[0]).toHaveTextContent("“inherently unequal”");
        expect(items[1]).toHaveTextContent("Quote not in source · Citation 2");
    });

    it("says when the citations did not change since the last check", () => {
        show(done([check(1, "exists-and-matches")], "v1"));
        expect(screen.getByRole("status")).toHaveTextContent("Citations unchanged since the last check · 1 citation verified");
    });

    it("counts verdicts", () => {
        expect(summarizeChecks([check(1, "not-found"), check(2, "exists-and-matches")])).toMatchObject({ verified: 1, unverifiable: 0 });
    });
});
