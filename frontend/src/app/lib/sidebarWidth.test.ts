import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarWidthClass, watchSidebarWidthClass } from "./sidebarWidth";

/** A matchMedia for a window `width` px wide, which the test can resize. */
function stubWidth(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      const min = Number(/min-width: (\d+)px/.exec(query)?.[1]);
      return width >= min;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: number) {
      width = next;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("sidebarWidthClass", () => {
  it("is narrow on a phone, medium on an iPad in portrait, wide in landscape", () => {
    for (const [width, expected] of [
      [390, "narrow"],
      [767, "narrow"],
      [768, "medium"],
      [834, "medium"],
      [951, "medium"],
      [1023, "medium"],
      [1024, "wide"],
      [1180, "wide"],
    ] as const) {
      stubWidth(width);
      expect(sidebarWidthClass()).toBe(expected);
    }
  });

  it("goes by innerWidth where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("innerWidth", 1280);
    expect(sidebarWidthClass()).toBe("wide");
    vi.stubGlobal("innerWidth", 820);
    expect(sidebarWidthClass()).toBe("medium");
    vi.stubGlobal("innerWidth", 390);
    expect(sidebarWidthClass()).toBe("narrow");
  });
});

describe("watchSidebarWidthClass", () => {
  it("reports only crossings into another class", () => {
    const media = stubWidth(1180);
    const onChange = vi.fn();
    const stop = watchSidebarWidthClass(onChange);
    media.resize(1100);
    expect(onChange).not.toHaveBeenCalled();
    media.resize(900);
    media.resize(820);
    expect(onChange.mock.calls).toEqual([["medium"]]);
    media.resize(500);
    media.resize(1200);
    expect(onChange.mock.calls).toEqual([["medium"], ["narrow"], ["wide"]]);
    stop();
    expect(media.listeners.size).toBe(0);
  });
});
