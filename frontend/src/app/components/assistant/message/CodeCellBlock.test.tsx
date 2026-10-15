import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CodeCellBlock } from "./CodeCellBlock";

const code = "docs = await tools.gather(tools.read_document(doc_id='doc-0'))\nprint(len(docs))";

describe("CodeCellBlock", () => {
    it("says it is computing while the cell runs", () => {
        render(<CodeCellBlock event={{ type: "code_cell", call_id: "p1", code, status: "running" }} />);
        expect(screen.getByRole("button", { name: /Computing/ })).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText(/print\(len/)).toBeNull();
    });

    it("shows steps and time when done, and the code and result when opened", () => {
        render(
            <CodeCellBlock
                event={{ type: "code_cell", call_id: "p1", code, status: "ok", output: "1", tool_calls: 3, duration_ms: 1234 }}
            />,
        );
        const toggle = screen.getByRole("button", { name: /Computed\s?· 3 steps · 1\.2 s/ });
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText(/print\(len\(docs\)\)/)).toBeInTheDocument();
        expect(screen.getByText("Result")).toBeInTheDocument();
    });

    it("names a cell that stopped on an error", () => {
        render(<CodeCellBlock event={{ type: "code_cell", call_id: "p1", code, status: "failed", output: "[error]\nZeroDivisionError" }} />);
        expect(screen.getByRole("button", { name: /Computation stopped/ })).toBeInTheDocument();
    });

    it("opens the next cell the way the reader left the last one", () => {
        const cell = (id: string) => (
            <CodeCellBlock event={{ type: "code_cell", call_id: id, code, status: "ok", output: "1" }} />
        );
        // Shut by default, for someone who only wants the answer.
        const first = render(cell("p1"));
        expect(screen.getByRole("button", { name: /Computed/ })).toHaveAttribute("aria-expanded", "false");
        // Opened for debugging: the next cell opens too, on a later page as well.
        fireEvent.click(screen.getByRole("button", { name: /Computed/ }));
        first.unmount();
        const second = render(cell("p2"));
        expect(screen.getByRole("button", { name: /Computed/ })).toHaveAttribute("aria-expanded", "true");
        expect(localStorage.getItem("mike.disclosure.code-cell")).toBe("1");
        // Closed again: the next one stays shut.
        fireEvent.click(screen.getByRole("button", { name: /Computed/ }));
        second.unmount();
        render(cell("p3"));
        expect(screen.getByRole("button", { name: /Computed/ })).toHaveAttribute("aria-expanded", "false");
    });
});
