import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setVoiceModeActive, subscribeVoiceMode, useVoiceModeActive, voiceModeActive } from "./voiceMode";

describe("voice mode flag", () => {
    it("tells listeners and components when voice mode starts and ends, once per change", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeVoiceMode(listener);
        const { result } = renderHook(() => useVoiceModeActive());
        expect(result.current).toBe(false);
        act(() => setVoiceModeActive(true));
        act(() => setVoiceModeActive(true));
        expect(voiceModeActive()).toBe(true);
        expect(result.current).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        act(() => setVoiceModeActive(false));
        expect(listener).toHaveBeenLastCalledWith(false);
        unsubscribe();
        act(() => setVoiceModeActive(true));
        expect(listener).toHaveBeenCalledTimes(2);
        act(() => setVoiceModeActive(false));
    });

    it("is off when rendered on the server, whatever the page holds", () => {
        setVoiceModeActive(true);
        function Probe() {
            return createElement("span", null, String(useVoiceModeActive()));
        }
        expect(renderToString(createElement(Probe))).toBe("<span>false</span>");
        setVoiceModeActive(false);
    });
});
