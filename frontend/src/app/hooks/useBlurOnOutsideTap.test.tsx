import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useBlurOnOutsideTap } from "./useBlurOnOutsideTap";

function Page() {
    const field = useRef<HTMLTextAreaElement>(null);
    const surface = useRef<HTMLDivElement>(null);
    useBlurOnOutsideTap(field, surface);
    return (
        <div>
            <p data-testid="text">An answer</p>
            <button type="button">Citation 1</button>
            <div ref={surface}>
                <textarea aria-label="Message" ref={field} />
                <span data-testid="inside">controls</span>
            </div>
        </div>
    );
}

type Touch = { x?: number; y?: number; at?: number; type?: string; id?: number };
function tap(target: Element, down: Touch = {}, up: Touch = {}) {
    const base = { pointerType: down.type ?? "touch", pointerId: down.id ?? 1 };
    fireEvent.pointerDown(target, { ...base, clientX: down.x ?? 10, clientY: down.y ?? 10 });
    fireEvent.pointerUp(target, { ...base, pointerId: up.id ?? base.pointerId, clientX: up.x ?? down.x ?? 10, clientY: up.y ?? down.y ?? 10 });
}

function setup() {
    const view = render(<Page />);
    const field = view.getByLabelText("Message");
    field.focus();
    return { ...view, field };
}

describe("useBlurOnOutsideTap", () => {
    it("closes the keyboard when the page is tapped", () => {
        const { field, getByTestId } = setup();
        tap(getByTestId("text"));
        expect(document.activeElement).not.toBe(field);
    });

    it("leaves the field focused for taps inside the composer and on controls", () => {
        const { field, getByTestId, getByRole } = setup();
        tap(getByTestId("inside"));
        tap(getByRole("button", { name: "Citation 1" }));
        expect(document.activeElement).toBe(field);
    });

    it("leaves the field focused for drags, mouse clicks and a mismatched or cancelled touch", () => {
        const { field, getByTestId } = setup();
        const text = getByTestId("text");
        tap(text, { y: 10 }, { y: 60 });
        tap(text, { type: "mouse" });
        tap(text, { id: 1 }, { id: 2 });
        fireEvent.pointerDown(text, { pointerType: "touch", pointerId: 3, clientX: 0, clientY: 0 });
        fireEvent.pointerCancel(text, { pointerType: "touch", pointerId: 3 });
        fireEvent.pointerUp(text, { pointerType: "touch", pointerId: 3, clientX: 0, clientY: 0 });
        expect(document.activeElement).toBe(field);
    });

    it("does nothing when the field is not focused, or after unmounting", () => {
        const { field, getByTestId, unmount } = setup();
        field.blur();
        tap(getByTestId("text"));
        expect(document.activeElement).toBe(document.body);
        unmount();
        tap(document.body);
    });
});
