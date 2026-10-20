"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import { BrowserModelError, type PhononVoice } from "@/app/lib/voice/browserModels";
import { GlassIconButtonUI } from "@/shared/ui/GlassIconButtonUI";

/** One short, neutral sentence with a question and numbers, so a sample shows rising and falling pitch. */
export const VOICE_SAMPLE_TEXT = "Is the meeting still at 3:30 on Thursday? If it moved, let me know before noon.";

export const VOICE_SAMPLE_FAILED_MESSAGE = "Could not play this sample. Please try again.";

/** Samples already made this session, so a replay is instant. Keyed by engine and voice. */
const sampleCache = new Map<string, Blob>();
const cacheKey = (engine: string, voice: string) => `${engine}:${voice}`;

/** Forget the samples (tests; the page reload does this in use). */
export function clearVoiceSampleCache(): void {
  sampleCache.clear();
}

const sampleError = (error: unknown) =>
  error instanceof DeviceSpeechError || error instanceof BrowserModelError
    ? error.message
    : userFacingApiError(error, VOICE_SAMPLE_FAILED_MESSAGE);

/**
 * Phonon's voices as a list: choose one (saved at once) and hear a sample of
 * any of them on the engine in use. One sample plays at a time.
 */
export function PhononVoiceList({
  voices,
  value,
  engine,
  synthesize,
  onSelect,
  playDisabledReason,
  preparing = false,
}: {
  voices: readonly PhononVoice[];
  /** The chosen voice's id. */
  value: string;
  /** Which engine makes the samples ("device" or "webgpu"); each has its own cache. */
  engine: string;
  synthesize: (text: string, voice: string) => Promise<Blob>;
  onSelect: (voice: string) => void;
  /** Set while samples cannot play yet (Phonon not installed): says what to do. */
  playDisabledReason?: string;
  /** The phone says Phonon must be prepared again first, so the first sample takes about ten seconds. */
  preparing?: boolean;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ voice: string; message: string } | null>(null);
  // Whether a sample has been made on this engine, so the wait is no longer the first.
  const [madeASample, setMadeASample] = useState(() =>
    [...sampleCache.keys()].some((key) => key.startsWith(`${engine}:`)),
  );
  const run = useRef(0);
  const audio = useRef<{ element: HTMLAudioElement; url: string } | null>(null);

  const silence = () => {
    run.current += 1;
    const current = audio.current;
    audio.current = null;
    if (current) {
      current.element.pause();
      URL.revokeObjectURL(current.url);
    }
  };

  useEffect(() => silence, []);

  const stop = () => {
    silence();
    setLoading(null);
    setPlaying(null);
  };

  const play = async (voice: string) => {
    silence();
    const token = run.current;
    setFailed(null);
    setPlaying(null);
    const key = cacheKey(engine, voice);
    let blob = sampleCache.get(key);
    if (!blob) {
      setLoading(voice);
      try {
        blob = await synthesize(VOICE_SAMPLE_TEXT, voice);
      } catch (error) {
        if (token !== run.current) return;
        setLoading(null);
        setFailed({ voice, message: sampleError(error) });
        return;
      }
      sampleCache.set(key, blob);
      setMadeASample(true);
      if (token !== run.current) return;
      setLoading(null);
    }
    const url = URL.createObjectURL(blob);
    const element = new Audio(url);
    audio.current = { element, url };
    const finished = () => {
      if (token !== run.current) return;
      silence();
      setPlaying(null);
    };
    element.addEventListener("ended", finished);
    setPlaying(voice);
    try {
      await element.play();
    } catch {
      if (token !== run.current) return;
      silence();
      setPlaying(null);
      setFailed({ voice, message: VOICE_SAMPLE_FAILED_MESSAGE });
    }
  };


  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Read-aloud voice" className="space-y-1">
        {voices.map((voice) => {
          const selected = voice.id === value;
          const busy = loading === voice.id;
          const active = playing === voice.id;
          return (
            <div
              key={voice.id}
              className={`flex flex-wrap items-start gap-x-2 gap-y-1 rounded-xl px-3 py-2 transition-colors ${selected ? "bg-accent" : "hover:bg-accent/60"}`}
            >
              <label className="flex min-w-[10rem] flex-1 cursor-pointer items-start gap-3 has-[:focus-visible]:rounded-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500/40 has-[:focus-visible]:ring-offset-2">
                <input
                  type="radio"
                  name="phonon-voice"
                  value={voice.id}
                  checked={selected}
                  onChange={() => onSelect(voice.id)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-inset ring-muted-foreground peer-checked:ring-primary peer-checked:[&>span]:scale-100"
                >
                  <span className="h-2 w-2 scale-0 rounded-full bg-primary transition-transform" />
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block text-sm text-foreground">{voice.label}</span>
                  <span className="block text-xs text-muted-foreground">{voice.detail}</span>
                </span>
              </label>
              <GlassIconButtonUI
                aria-label={busy || active ? "Stop" : `Play a sample of ${voice.label}`}
                disabled={!busy && !active && !!playDisabledReason}
                onClick={() => (busy || active ? stop() : void play(voice.id))}
                className="disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : active ? (
                  <Square aria-hidden="true" className="h-3 w-3 fill-current" />
                ) : (
                  <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
                )}
              </GlassIconButtonUI>
              {busy && (
                <p role="status" className="basis-full pl-7 text-xs text-muted-foreground">
                  {preparing && !madeASample
                    ? "Preparing Phonon… this takes about ten seconds."
                    : "Preparing the sample…"}
                </p>
              )}
              {failed?.voice === voice.id && (
                <p role="alert" className="basis-full pl-7 text-xs text-red-600">
                  {failed.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {playDisabledReason && <SettingsDescription>{playDisabledReason}</SettingsDescription>}
    </div>
  );
}
