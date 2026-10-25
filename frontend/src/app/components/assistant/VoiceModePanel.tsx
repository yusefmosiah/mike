"use client";

import { useEffect, useRef } from "react";
import { AudioLines, Hand, Loader2, Mic, PhoneOff, SlidersHorizontal } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { CHAT_COMPOSER_SURFACE_CLASS } from "./composerSurface";
import type { UseVoiceChatResult, VoiceActivity } from "@/app/hooks/useVoiceChat";
import { setupEstimateLabel } from "@/app/lib/voice/pricing";
import { voiceMicrophoneModes, voiceMicrophoneModesSupported } from "@/app/lib/voice/voiceEngine";

/** A download size as said before it starts: "about 450 MB", "about 1.2 GB". */
export function formatDownloadSize(bytes: number): string {
    const megabytes = bytes / 1e6;
    if (megabytes >= 1000) return `about ${(megabytes / 1000).toFixed(1)} GB`;
    return `about ${Math.max(1, Math.round(megabytes))} MB`;
}

const ACTIVITY_LABELS: Readonly<Record<VoiceActivity, string>> = {
    listening: "Listening",
    thinking: "Thinking",
    speaking: "Speaking",
};

/**
 * The state in shape as well as in words: a microphone in a ring while
 * listening, three dots while thinking, sound bars while speaking.
 */
function ActivityShape({ activity }: { activity: VoiceActivity }) {
    return (
        <span
            aria-hidden="true"
            data-activity={activity}
            className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900/5 text-gray-700"
        >
            {activity === "listening" && (
                <>
                    <span className="absolute inset-0 rounded-full ring-2 ring-gray-400/60 motion-safe:animate-pulse" />
                    <Mic className="h-4 w-4" />
                </>
            )}
            {activity === "thinking" && (
                <span className="flex items-center gap-1">
                    {[0, 150, 300].map((delay) => (
                        <span
                            key={delay}
                            className="h-1.5 w-1.5 rounded-full bg-gray-600 motion-safe:animate-bounce"
                            style={{ animationDelay: `${delay}ms` }}
                        />
                    ))}
                </span>
            )}
            {activity === "speaking" && <AudioLines className="h-5 w-5 motion-safe:animate-pulse" />}
        </span>
    );
}

/**
 * Shared frame: the composer's shape whatever the panel shows, so nothing
 * jumps when one replaces the other. Same surface; the composer's resting
 * height (100px: its borders, pt-4 above the textarea's line box, then
 * py-2.5 around its h-8 controls), its text's inset on the left and its
 * controls' inset on the right and bottom, so End lines up with Send. In the
 * iPhone app, edge to edge, globals.css gives both the display's corner
 * radius and the deeper insets. Where the words would be squeezed beside
 * End, End wraps below them, to the bottom right, where Send sits.
 */
function Frame({ children, label, phase }: { children: React.ReactNode; label: string; phase: string }) {
    const ref = useRef<HTMLElement>(null);
    // The control that started voice mode is gone: focus moves to the one
    // that ends it (or, in setup, the next step), at each change of step.
    useEffect(() => {
        ref.current?.querySelector<HTMLButtonElement>("[data-voice-primary]")?.focus();
    }, [phase]);
    return (
        <section
            ref={ref}
            aria-label={label}
            data-slot="voice-mode-panel"
            className={cn(
                "flex min-h-[100px] w-full flex-wrap items-center gap-3 pb-2.5 pl-4 pr-2.5 pt-4",
                CHAT_COMPOSER_SURFACE_CLASS,
            )}
        >
            {children}
        </section>
    );
}

function EndButton({ onClick, label = "End" }: { onClick: () => void; label?: string }) {
    return (
        <PillButtonUI tone="white" size="sm" onClick={onClick} className="ml-auto shrink-0" data-voice-primary="">
            <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
        </PillButtonUI>
    );
}

/**
 * Voice mode, in place of the composer. The person talks and is answered
 * aloud; the thread above shows the conversation as ordinary chat. There is
 * no push-to-talk. In the iPhone app speaking interrupts and End is the one
 * control; in a browser (docs/voice-web.md) voice mode does not listen while
 * it speaks, so "Tap to interrupt" stops the answer. The live state and words
 * are not announced as they change, so a screen reader does not talk over the
 * spoken answer (the composer announces only that voice mode began or ended).
 */
export function VoiceModePanel({
    voice,
}: {
    voice: Pick<
        UseVoiceChatResult,
        | "phase"
        | "activity"
        | "partial"
        | "ignoredOtherVoice"
        | "installProgress"
        | "downloadBytes"
        | "preparation"
        | "error"
        | "install"
        | "stop"
    > &
        Partial<Pick<UseVoiceChatResult, "inBrowser" | "sentence" | "downloadMinutes" | "interrupt">>;
}) {
    const { phase, activity, partial, ignoredOtherVoice, installProgress, downloadBytes, preparation, error } = voice;
    const { inBrowser, sentence, downloadMinutes } = voice;

    if (phase === "setup" || phase === "installing") {
        const fraction = installProgress ?? 0;
        // The last step: the phone prepares the models (no measurable progress).
        const preparing = phase === "installing" && fraction >= 1;
        return (
            <Frame label="Voice mode setup" phase={phase}>
                <div className="min-w-0 flex-1 basis-56 space-y-2">
                    {inBrowser ? (
                        <>
                            <p className="text-sm text-gray-700">
                                Voice mode needs speech models in this browser ({setupEstimateLabel(downloadMinutes ?? 1)}{" "}
                                to download, once).
                            </p>
                            {sentence && <p className="text-sm text-gray-600 [overflow-wrap:anywhere]">{sentence}</p>}
                        </>
                    ) : (
                        <p className="text-sm text-gray-700">
                            Voice mode needs speech models on this iPhone ({formatDownloadSize(downloadBytes)}, downloaded
                            once). What you say stays on the phone.
                        </p>
                    )}
                    {phase === "installing" ? (
                        <div className="space-y-1">
                            <p className="text-xs text-gray-600">
                                {preparing
                                    ? inBrowser
                                        ? "Getting ready…"
                                        : "Preparing for this phone…"
                                    : "Downloading speech models…"}
                            </p>
                            <div
                                role="progressbar"
                                aria-label={preparing ? "Preparing speech models" : "Downloading speech models"}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={preparing ? undefined : Math.round(fraction * 100)}
                                className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
                            >
                                <div
                                    className={cn(
                                        "h-full rounded-full bg-gray-700",
                                        preparing ? "w-full motion-safe:animate-pulse" : "transition-[width]",
                                    )}
                                    style={preparing ? undefined : { width: `${Math.round(fraction * 100)}%` }}
                                />
                            </div>
                        </div>
                    ) : (
                        error && (
                            <p role="alert" className="text-sm text-red-600 [overflow-wrap:anywhere]">
                                {error}
                            </p>
                        )
                    )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {phase === "setup" && (
                        <PillButtonUI tone="black" size="sm" onClick={() => void voice.install()} data-voice-primary="">
                            Download
                        </PillButtonUI>
                    )}
                    <PillButtonUI
                        tone="white"
                        size="sm"
                        onClick={voice.stop}
                        {...(phase === "installing" ? { "data-voice-primary": "" } : {})}
                    >
                        Cancel
                    </PillButtonUI>
                </div>
            </Frame>
        );
    }

    if (phase === "checking" || phase === "starting") {
        // The phone compiles each model once after an install or an update
        // (about a minute), then keeps the result; say so instead of a bare wait.
        const firstUse = preparation.preparing && preparation.firstTime;
        return (
            <Frame label="Voice mode" phase={phase}>
                <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900/5 text-gray-600"
                >
                    <Loader2 className="h-4 w-4 animate-spin" />
                </span>
                <div role="status" aria-live="polite" className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-medium text-gray-800">
                        {firstUse ? "Preparing voice mode for first use…" : "Starting voice mode…"}
                    </p>
                    {firstUse && (
                        <p className="text-sm text-gray-600">
                            This happens once after an install or an update and can take about a minute.
                        </p>
                    )}
                </div>
                <EndButton onClick={voice.stop} label="Cancel" />
            </Frame>
        );
    }

    // In a browser voice mode does not hear the person over its own answer.
    const tapToInterrupt = inBrowser && activity !== "listening" && !!voice.interrupt;
    return (
        <Frame label="Voice mode" phase={phase}>
            <ActivityShape activity={activity} />
            <div className="min-w-0 flex-1 basis-32">
                <p className="text-sm font-medium text-gray-900" data-testid="voice-activity">
                    {ACTIVITY_LABELS[activity]}
                </p>
                <p className="text-sm text-gray-600 [overflow-wrap:anywhere]">
                    {partial ||
                        (ignoredOtherVoice
                            ? "Another voice, not sent."
                            : activity === "listening"
                              ? "Speak when you’re ready."
                              : inBrowser
                                ? activity === "speaking"
                                    ? "Not listening while it speaks."
                                    : "Speak, or tap to interrupt."
                                : "Speak to interrupt.")}
                </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
                {tapToInterrupt && (
                    <PillButtonUI tone="black" size="sm" onClick={() => voice.interrupt?.()}>
                        <Hand className="h-3.5 w-3.5" aria-hidden="true" />
                        Tap to interrupt
                    </PillButtonUI>
                )}
                {voiceMicrophoneModesSupported() && (
                    <PillButtonUI
                        tone="white"
                        size="sm"
                        onClick={() => void voiceMicrophoneModes()}
                        aria-label="Microphone mode"
                        title="Microphone mode"
                    >
                        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    </PillButtonUI>
                )}
                <EndButton onClick={voice.stop} />
            </div>
        </Frame>
    );
}
