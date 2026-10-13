import { Loader2, Pause, Play, Square } from "lucide-react";
import { READ_ALOUD_SPEEDS, type UseReadAloud } from "./useReadAloud";

const BUTTON_CLASS =
    "p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

export function formatReadAloudTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The player under a response while it is read aloud: play and pause, a
 * position bar that seeks, the time, the speed and stop. While the next
 * stretch of audio is being synthesized it says so.
 */
export function ReadAloudPlayer({ readAloud }: { readAloud: UseReadAloud }) {
    const stopButton = (
        <button type="button" aria-label="Stop reading" className={BUTTON_CLASS} onClick={readAloud.stop}>
            <Square className="h-3 w-3" />
        </button>
    );

    if (readAloud.status === "preparing") {
        return (
            <div className="flex flex-wrap items-center gap-2 pb-2 font-sans" role="group" aria-label="Read aloud">
                <Loader2 className="h-3 w-3 animate-spin text-gray-400" aria-hidden="true" />
                <span className="text-xs text-gray-500" role="status">
                    Preparing audio…
                </span>
                {stopButton}
            </div>
        );
    }

    const seconds = readAloud.unit === "seconds";
    const max = seconds ? readAloud.length : Math.max(readAloud.length - 1, 0);
    return (
        <div className="flex flex-wrap items-center gap-2 pb-2 font-sans" role="group" aria-label="Read aloud">
            {readAloud.status === "paused" ? (
                <button type="button" aria-label="Resume reading" className={BUTTON_CLASS} onClick={readAloud.resume}>
                    <Play className="h-3 w-3" />
                </button>
            ) : (
                <button type="button" aria-label="Pause reading" className={BUTTON_CLASS} onClick={readAloud.pause}>
                    <Pause className="h-3 w-3" />
                </button>
            )}
            <input
                type="range"
                aria-label="Reading position"
                aria-valuetext={
                    seconds
                        ? `${formatReadAloudTime(readAloud.position)} of ${formatReadAloudTime(readAloud.length)}`
                        : `Sentence ${readAloud.position + 1} of ${readAloud.length}`
                }
                min={0}
                max={max}
                step={seconds ? "any" : 1}
                value={Math.min(readAloud.position, max)}
                disabled={max === 0}
                onChange={(event) => readAloud.seek(Number(event.target.value))}
                className="h-1 min-w-[8rem] flex-1 cursor-pointer accent-gray-700 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-default"
            />
            {seconds && (
                <span className="text-xs text-gray-500 tabular-nums">
                    {`${formatReadAloudTime(readAloud.position)} / ${formatReadAloudTime(readAloud.length)}`}
                </span>
            )}
            <select
                aria-label="Reading speed"
                className="text-xs text-gray-500 bg-transparent rounded px-1 py-0.5 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                value={readAloud.speed}
                onChange={(event) => readAloud.setSpeed(Number(event.target.value))}
            >
                {READ_ALOUD_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>
                        {speed}x
                    </option>
                ))}
            </select>
            {stopButton}
        </div>
    );
}
