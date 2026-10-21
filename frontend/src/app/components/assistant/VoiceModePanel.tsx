"use client";

import { useEffect, useRef } from "react";
import { AudioLines, Loader2, Mic, PhoneOff, SlidersHorizontal } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { CHAT_COMPOSER_SURFACE_CLASS } from "./composerSurface";
import type { UseVoiceChatResult, VoiceActivity } from "@/app/hooks/useVoiceChat";
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
 * no push-to-talk and no tap to interrupt: speaking interrupts. End is the
 * one control. The live state and words are not announced as they change,
 * so VoiceOver does not talk over the spoken answer (the composer announces
 * only that voice mode began or ended).
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
        | "error"
        | "install"
        | "stop"
    >;
}) {
    const { phase, activity, partial, ignoredOtherVoice, installProgress, downloadBytes, error } = voice;

    if (phase === "setup" || phase === "installing") {
        const fraction = installProgress ?? 0;
        // The last step: the phone prepares the models (no measurable progress).
        const preparing = phase === "installing" && fraction >= 1;
        return (
            <Frame label="Voice mode setup" phase={phase}>
                <div className="min-w-0 flex-1 basis-56 space-y-2">
                    <p className="text-sm text-gray-700">
                        Voice mode needs speech models on this iPhone ({formatDownloadSize(downloadBytes)}, downloaded
                        once). What you say stays on the phone.
                    </p>
                    {phase === "installing" ? (
                        <div className="space-y-1">
                            <p className="text-xs text-gray-600">
                                {preparing ? "Preparing for this phone…" : "Downloading speech models…"}
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
        return (
            <Frame label="Voice mode" phase={phase}>
                <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900/5 text-gray-600"
                >
                    <Loader2 className="h-4 w-4 animate-spin" />
                </span>
                <p className="min-w-0 flex-1 text-sm font-medium text-gray-800">Starting voice mode…</p>
                <EndButton onClick={voice.stop} label="Cancel" />
            </Frame>
        );
    }

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
                              : "Speak to interrupt.")}
                </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
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
