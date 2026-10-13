import { StrictMode, useLayoutEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReasoningDisclosure } from "./useReasoningDisclosure";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let height: number;
let measurements: ReturnType<typeof vi.fn<() => number>>;
let observers: { resize: () => void; disconnect: ReturnType<typeof vi.fn> }[];
let commits: number;

function Harness({ streaming = true, text = "Reasoning" }) {
    const disclosure = useReasoningDisclosure(streaming);
    useLayoutEffect(() => { commits++; });
    return <>
        <button aria-expanded={disclosure.isContentOpen} onClick={disclosure.toggleContent}>Thought process</button>
        {disclosure.isContentOpen && <div ref={disclosure.contentRef}>{text}</div>}
        <output>{disclosure.isOverflowing ? "overflow" : "fits"}</output>
        <button onClick={() => disclosure.setIsExpanded(!disclosure.isExpanded)}>
            {disclosure.isExpanded ? "Minimise" : "Expand"}
        </button>
    </>;
}

function WindowHarness({ streaming = true }) {
    const { contentRef, windowRef, onWindowScroll, windowScroll } = useReasoningDisclosure(streaming);
    return (
        <div data-testid="window" ref={windowRef} onScroll={onWindowScroll}>
            <div ref={contentRef}>Reasoning</div>
            <output>{windowScroll}</output>
        </div>
    );
}

function flushFrame() {
    act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(16));
    });
}

beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    height = 24;
    commits = 0;
    observers = [];
    measurements = vi.fn(() => height);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(measurements);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(resize: () => void) { observers.push({ resize, disconnect: this.disconnect }); }
    });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reasoning disclosure", () => {
    it("does not remeasure or dispatch state for 300 text chunks without a size change", () => {
        const view = render(<Harness />);
        flushFrame();
        const initialCommits = commits;
        for (let i = 0; i < 300; i++) view.rerender(<Harness text={`Chunk ${i}`} />);
        expect(measurements).toHaveBeenCalledTimes(1);
        expect(observers).toHaveLength(1);
        expect(frames.size).toBe(0);
        expect(commits).toBe(initialCommits + 300);
    });

    it("coalesces resize notifications and dispatches only overflow transitions", () => {
        render(<Harness />);
        flushFrame();
        const initialCommits = commits;
        for (let i = 0; i < 300; i++) observers[0].resize();
        expect(frames.size).toBe(1);
        flushFrame();
        expect(commits).toBe(initialCommits);
        height = 300;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));
        height = 24;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("fits")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
        height = 300;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
    });

    it("opens while streaming and stays open after, until the reader closes it", () => {
        // A thought loaded already finished starts closed.
        const view = render(<Harness streaming={false} />);
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        expect(observers).toHaveLength(0);
        // It opens when it streams, and does not close when the segment or
        // the answer ends.
        view.rerender(<Harness />);
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        view.rerender(<Harness streaming={false} />);
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Thought process" })).toHaveAttribute("aria-expanded", "true");
        // The reader's choice wins, through later streaming and completion.
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        view.rerender(<Harness />);
        view.rerender(<Harness streaming={false} />);
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        view.rerender(<Harness />);
        view.rerender(<Harness streaming={false} />);
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
    });

    it("keeps the collapsed window on the newest lines until the reader scrolls up in it", () => {
        // A window 100px tall over content of `height`.
        vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
        const view = render(<WindowHarness />);
        const element = screen.getByTestId("window");
        height = 300;
        act(() => observers[0].resize());
        expect(element.scrollTop).toBe(300);
        fireEvent.scroll(element);
        expect(screen.getByText("end")).toBeInTheDocument();

        // The reader scrolls up inside it: new lines no longer move it.
        element.scrollTop = 120;
        fireEvent.scroll(element);
        expect(screen.getByText("middle")).toBeInTheDocument();
        height = 400;
        act(() => observers[0].resize());
        expect(element.scrollTop).toBe(120);

        // Back at its end, it follows again.
        element.scrollTop = 300;
        fireEvent.scroll(element);
        height = 500;
        act(() => observers[0].resize());
        expect(element.scrollTop).toBe(500);

        // A finished thought stays where it is.
        view.rerender(<WindowHarness streaming={false} />);
        element.scrollTop = 0;
        fireEvent.scroll(element);
        expect(screen.getByText("start")).toBeInTheDocument();
        height = 600;
        act(() => observers[0].resize());
        expect(element.scrollTop).toBe(0);
    });

    it("remeasures after reopening and cleans up pending work in Strict Mode", () => {
        const view = render(<StrictMode><Harness /></StrictMode>);
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(1);
        flushFrame();
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        height = 300;
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
        observers.at(-1)!.resize();
        expect(frames.size).toBe(1);
        view.unmount();
        expect(frames.size).toBe(0);
        for (const observer of observers) {
            expect(observer.disconnect).toHaveBeenCalledTimes(1);
            observer.resize();
        }
        expect(frames.size).toBe(0);
    });
});
