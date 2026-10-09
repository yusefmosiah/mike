"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import {
  BROWSER_MODELS,
  estimateBrowserModelSetup,
  hasBrowserModelConsent,
  loadBrowserSpeaker,
  loadBrowserTranscriber,
  setBrowserModelConsent,
  webgpuAvailable,
  type BrowserModelKind,
} from "@/app/lib/voice/browserModels";
import { setupEstimateLabel } from "@/app/lib/voice/pricing";

type Phase =
  | { step: "ask" }
  | { step: "estimating" }
  | { step: "estimated"; minutes: number | null }
  | { step: "loading"; progress: number }
  | { step: "ready" }
  | { step: "failed" };

/**
 * Consent for an open model that runs in this browser. Nothing is fetched
 * until the user asks: first how long setup takes (a short speed test
 * against the model host), then the setup itself.
 */
export function BrowserModelSetup({ kind }: { kind: BrowserModelKind }) {
  const spec = BROWSER_MODELS[kind];
  const [phase, setPhase] = useState<Phase>(() =>
    hasBrowserModelConsent(kind) ? { step: "ready" } : { step: "ask" },
  );
  const backend = webgpuAvailable() ? "WebGPU" : "WebAssembly (slower; this browser has no WebGPU)";

  const estimate = async () => {
    setPhase({ step: "estimating" });
    try {
      setPhase({ step: "estimated", minutes: await estimateBrowserModelSetup(kind) });
    } catch {
      setPhase({ step: "estimated", minutes: null });
    }
  };

  const setUp = async () => {
    setBrowserModelConsent(kind, true);
    setPhase({ step: "loading", progress: 0 });
    try {
      const onProgress = (fraction: number) => setPhase({ step: "loading", progress: fraction });
      if (kind === "transcription") await loadBrowserTranscriber(onProgress);
      else await loadBrowserSpeaker(onProgress);
      setPhase({ step: "ready" });
    } catch {
      setBrowserModelConsent(kind, false);
      setPhase({ step: "failed" });
    }
  };

  const turnOff = () => {
    setBrowserModelConsent(kind, false);
    setPhase({ step: "ask" });
  };

  return (
    <div className="space-y-2">
      <SettingsDescription>
        {spec.label} runs in this browser on {backend}. What you say and what is read
        aloud stay on this device; the model is downloaded once and kept in the
        browser&apos;s cache.
      </SettingsDescription>
      {phase.step === "ask" && (
        <PillButtonUI tone="white" size="sm" onClick={() => void estimate()}>
          Check how long setup takes
        </PillButtonUI>
      )}
      {phase.step === "estimating" && (
        <PillButtonUI tone="white" size="sm" loading>
          Checking this connection
        </PillButtonUI>
      )}
      {phase.step === "estimated" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-gray-700">
            {phase.minutes === null
              ? "Setup time could not be measured."
              : `Setup takes ${setupEstimateLabel(phase.minutes)} on this connection.`}
          </p>
          <PillButtonUI tone="black" size="sm" onClick={() => void setUp()}>
            Set up {spec.label}
          </PillButtonUI>
          <PillButtonUI tone="white" size="sm" onClick={() => setPhase({ step: "ask" })}>
            Not now
          </PillButtonUI>
        </div>
      )}
      {phase.step === "loading" && (
        <div className="space-y-1">
          <p className="text-sm text-gray-700">Setting up {spec.label}…</p>
          <div
            role="progressbar"
            aria-label={`Setting up ${spec.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(phase.progress * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
          >
            <div
              className="h-full rounded-full bg-gray-700 transition-[width]"
              style={{ width: `${Math.round(phase.progress * 100)}%` }}
            />
          </div>
        </div>
      )}
      {phase.step === "ready" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-gray-700">Set up on this device.</p>
          <PillButtonUI tone="white" size="sm" onClick={turnOff}>
            Stop using it
          </PillButtonUI>
        </div>
      )}
      {phase.step === "failed" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600" role="alert">
            Setup did not finish. Check the connection and try again.
          </p>
          <PillButtonUI tone="white" size="sm" onClick={() => setPhase({ step: "ask" })}>
            Try again
          </PillButtonUI>
        </div>
      )}
    </div>
  );
}
