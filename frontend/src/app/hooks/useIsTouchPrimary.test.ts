import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOUCH_PRIMARY_QUERY, useIsTouchPrimary } from "./useIsTouchPrimary";

afterEach(() => vi.unstubAllGlobals());

describe("useIsTouchPrimary", () => {
    it("reports a touch-first device", () => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn((query: string) => ({
                matches: query === TOUCH_PRIMARY_QUERY,
                addEventListener: () => {},
                removeEventListener: () => {},
            })),
        );
        expect(renderHook(() => useIsTouchPrimary()).result.current).toBe(true);
    });

    it("assumes a mouse where matchMedia does not exist", () => {
        vi.stubGlobal("matchMedia", undefined);
        expect(renderHook(() => useIsTouchPrimary()).result.current).toBe(false);
    });
});
