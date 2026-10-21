"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { formatDownloadSize } from "@/app/components/assistant/VoiceModePanel";
import {
  installFluidSpeechMini,
  removeFluidSpeechMini,
  type FluidSpeechMiniStatus,
} from "@/app/lib/voice/deviceSpeech";

/**
 * Fluid Speech Mini where the app downloads it on request (Android; the
 * iPhone app has it built in). The person downloads it here, sees the
 * progress, and can remove it again to free the space. Until it is on the
 * phone, dictation needs another engine.
 */
export function FluidSpeechMiniSetup({
  status,
  onChange,
}: {
  status: FluidSpeechMiniStatus;
  /** Called when the download or the removal ends, to read the status again. */
  onChange: () => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const downloading = progress !== null || status.state === "downloading";
  const fraction = progress ?? status.progress ?? 0;

  const download = async () => {
    setFailed(null);
    setProgress(0);
    try {
      await installFluidSpeechMini(setProgress);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The download did not finish.");
    }
    setProgress(null);
    onChange();
  };

  const remove = async () => {
    setFailed(null);
    setRemoving(true);
    await removeFluidSpeechMini();
    setRemoving(false);
    onChange();
  };

  const alert = failed && (
    <p className="text-sm text-red-600" role="alert">
      {failed}
    </p>
  );

  if (status.state === "available") {
    return (
      <div className="space-y-2">
        <SettingsDescription>Fluid Speech Mini runs on this phone and works offline; the recording never leaves it.</SettingsDescription>
        <PillButtonUI tone="white" size="sm" loading={removing} onClick={() => void remove()}>
          Remove Fluid Speech Mini
        </PillButtonUI>
        {alert}
      </div>
    );
  }

  const size = status.downloadBytes ? ` (${formatDownloadSize(status.downloadBytes)})` : "";
  return (
    <div className="space-y-2">
      <SettingsDescription>
        Fluid Speech Mini is not on this phone yet. Download it once{size} to dictate in English on the phone, offline.
        Only the model is downloaded; no recording is sent.
      </SettingsDescription>
      {downloading ? (
        <div className="space-y-1">
          <p className="text-sm text-gray-700">Downloading Fluid Speech Mini…</p>
          <div
            role="progressbar"
            aria-label="Downloading Fluid Speech Mini"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
          >
            <div className="h-full rounded-full bg-gray-700 transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        </div>
      ) : (
        <PillButtonUI tone="black" size="sm" onClick={() => void download()}>
          Download Fluid Speech Mini
        </PillButtonUI>
      )}
      {alert}
    </div>
  );
}
