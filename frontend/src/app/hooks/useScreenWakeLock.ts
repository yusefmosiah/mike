import { useEffect } from "react";

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

/**
 * Keeps the screen on while `active`, where the browser offers a screen wake
 * lock: dictation can run for minutes without a touch, and a phone that
 * sleeps part way through stops the microphone. Where there is no wake lock,
 * or the browser refuses one, the screen sleeps as usual. In the iPhone app
 * the phone also keeps the screen on while it listens itself (ScreenAwake).
 */
export function useScreenWakeLock(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
        if (!wakeLock) return;
        let released = false;
        let sentinel: WakeLockSentinelLike | null = null;
        wakeLock
            .request("screen")
            .then((held) => {
                if (released) void held.release().catch(() => undefined);
                else sentinel = held;
            })
            .catch(() => undefined);
        return () => {
            released = true;
            void sentinel?.release().catch(() => undefined);
        };
    }, [active]);
}
