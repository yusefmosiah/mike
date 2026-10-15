import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUCH_PRIMARY_QUERY } from "@/app/hooks/useIsTouchPrimary";
import { LONG_PRESS_MS } from "@/app/hooks/useLongPress";
import { UserMessage } from "./UserMessage";

function stubTouchScreen() {
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: query === TOUCH_PRIMARY_QUERY,
            addEventListener: () => {},
            removeEventListener: () => {},
        })),
    );
}

function holdOn(element: HTMLElement, pointerId = 1) {
    fireEvent.pointerDown(element, {
        pointerId,
        pointerType: "touch",
        clientX: 10,
        clientY: 10,
    });
}

describe("UserMessage on a touch screen", () => {
    beforeEach(() => {
        stubTouchScreen();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("drops the pencil and offers Edit and Copy on press and hold", () => {
        const onEdit = vi.fn();
        render(<UserMessage content="Summarise the lease" onEdit={onEdit} />);
        expect(screen.queryByRole("button", { name: "Edit prompt" })).toBeNull();

        holdOn(screen.getByText("Summarise the lease"));
        act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

        const edit = screen.getByRole("menuitem", { name: "Edit" });
        expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
        fireEvent.click(edit);
        expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it("does not open the menu for a scroll or a short tap", () => {
        render(<UserMessage content="Summarise the lease" onEdit={vi.fn()} />);
        const text = screen.getByText("Summarise the lease");

        holdOn(text);
        fireEvent.pointerMove(text, { pointerId: 1, clientX: 10, clientY: 40 });
        act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
        expect(screen.queryByRole("menu")).toBeNull();

        holdOn(text);
        fireEvent.pointerUp(text, { pointerId: 1 });
        act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("copies the prompt", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
        render(<UserMessage content="Summarise the lease" />);

        holdOn(screen.getByText("Summarise the lease"));
        act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
        });

        expect(writeText).toHaveBeenCalledWith("Summarise the lease");
        expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });

    it("keeps Edit unavailable while an answer streams", () => {
        render(
            <UserMessage
                content="Summarise the lease"
                onEdit={vi.fn()}
                editDisabled
            />,
        );
        holdOn(screen.getByText("Summarise the lease"));
        act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
        expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
            "aria-disabled",
            "true",
        );
    });

    it("lets a screen reader reach the same actions without holding", () => {
        render(<UserMessage content="Summarise the lease" onEdit={vi.fn()} />);
        expect(
            screen.getByRole("button", { name: "Prompt actions" }),
        ).toBeInTheDocument();
    });
});

describe("UserMessage with a mouse", () => {
    it("keeps the pencil and ignores a held mouse button", () => {
        vi.useFakeTimers();
        try {
            render(<UserMessage content="Summarise the lease" onEdit={vi.fn()} />);
            expect(
                screen.getByRole("button", { name: "Edit prompt" }),
            ).toBeInTheDocument();
            fireEvent.pointerDown(screen.getByText("Summarise the lease"), {
                pointerType: "mouse",
            });
            act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
            expect(screen.queryByRole("menu")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
