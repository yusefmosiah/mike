import { fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { TableToolbar } from "./TableToolbar";

describe("TableToolbar", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }),
        );
    });

    it("reduces left padding for icon actions on the right", () => {
        render(
            <TableToolbar
                items={[{ id: "all", label: "All" }]}
                active="all"
                actions={
                    <TabPillButtonUI>
                        <Plus aria-hidden="true" />
                        Folder
                    </TabPillButtonUI>
                }
            />,
        );

        const action = screen.getByRole("button", { name: "Folder" });
        expect(action).toHaveAttribute("data-slot", "tab-pill-button");
        expect(action.parentElement).toHaveClass(
            "[&_[data-slot=tab-pill-button]:has(svg)]:pl-2",
        );
    });

    it("does not horizontally clip the tab area", () => {
        render(
            <TableToolbar items={[{ id: "all", label: "All" }]} active="all" />,
        );

        expect(
            screen.getByRole("button", { name: "All" }).parentElement,
        ).not.toHaveClass("overflow-x-auto");
    });

    describe("on a phone", () => {
        beforeEach(() => {
            vi.stubGlobal(
                "matchMedia",
                vi.fn().mockReturnValue({
                    matches: false,
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                }),
            );
        });

        function openMenu() {
            const trigger = screen.getByRole("button", { name: "Toolbar actions" });
            fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
            return trigger;
        }

        it("closes the actions menu once an action runs, so the dialog it opens can be used", () => {
            const onPresets = vi.fn();
            render(
                <TableToolbar
                    actions={<TabPillButtonUI onClick={onPresets}>Browse presets</TabPillButtonUI>}
                />,
            );
            const trigger = openMenu();
            expect(trigger).toHaveAttribute("aria-expanded", "true");
            fireEvent.click(screen.getByRole("button", { name: "Browse presets" }));
            expect(onPresets).toHaveBeenCalledTimes(1);
            expect(trigger).toHaveAttribute("aria-expanded", "false");
            expect(screen.queryByRole("button", { name: "Browse presets" })).toBeNull();
        });

        it("keeps the menu open for an action that opens its own popup", () => {
            function Nested() {
                const [open, setOpen] = useState(false);
                return (
                    <div>
                        <TabPillButtonUI aria-expanded={open} onClick={() => setOpen(!open)}>
                            Actions
                        </TabPillButtonUI>
                        {open && <button type="button">Delete</button>}
                    </div>
                );
            }
            render(<TableToolbar actions={<Nested />} />);
            const trigger = openMenu();
            fireEvent.click(screen.getByRole("button", { name: "Actions" }));
            expect(trigger).toHaveAttribute("aria-expanded", "true");
            fireEvent.click(screen.getByRole("button", { name: "Delete" }));
            expect(trigger).toHaveAttribute("aria-expanded", "false");
        });
    });
});
