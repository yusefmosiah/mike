"use client";

import { useEffect, useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { formatDownloadSize } from "@/app/components/assistant/VoiceModePanel";
import {
  onVoiceEvent,
  VOICE_INSTALL_FAILURE_MESSAGE,
  VOICE_REMOVE_FAILURE_MESSAGE,
  voiceChatSupported,
  voiceInstall,
  voiceRemove,
  voiceStatus,
  type VoiceStatus,
} from "@/app/lib/voice/voiceEngine";

/** Voice mode's own models; Phonon and Fluid Speech Mini have their own settings. */
const VOICE_MODE_MODELS = ["vad", "eou", "smart-turn"];

/**
 * Voice mode's models on the phone: downloaded here or on first use, and
 * removable to free the space. Shown only in an app build with the engine.
 */
export function VoiceModeSetup() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!voiceChatSupported()) return;
    let live = true;
    void voiceStatus().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!status) return null;
  const installed = VOICE_MODE_MODELS.some((model) => !status.missing.includes(model));
  const missing = status.missing.length > 0;

  const download = async () => {
    setFailed(null);
    setProgress(0);
    const off = onVoiceEvent((event) => {
      if (event.type === "install") setProgress(event.fraction);
    });
    try {
      await voiceInstall();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : VOICE_INSTALL_FAILURE_MESSAGE);
    }
    off();
    setProgress(null);
    setStatus(await voiceStatus());
  };

  const remove = async () => {
    setFailed(null);
    setRemoving(true);
    try {
      setStatus(await voiceRemove());
    } catch (error) {
      setFailed(error instanceof Error ? error.message : VOICE_REMOVE_FAILURE_MESSAGE);
    }
    setRemoving(false);
  };

  return (
    <section className="space-y-3">
      <SettingsHeading>Voice mode</SettingsHeading>
      <SettingsCard>
        <SettingsRow layout="stacked">
          <div className="min-w-0 space-y-1">
            <SettingsLabel>Speech models</SettingsLabel>
            <SettingsDescription>
              {missing
                ? `Voice mode needs speech models on this iPhone (${formatDownloadSize(status.downloadBytes)}, downloaded once). They download here or the first time you start voice mode. What you say stays on the phone.`
                : "Voice mode's speech models are on this iPhone. What you say stays on the phone."}
            </SettingsDescription>
          </div>
          {progress !== null ? (
            <div className="space-y-1">
              <p className="text-sm text-gray-700">Downloading speech models…</p>
              <div
                role="progressbar"
                aria-label="Downloading speech models"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
              >
                <div
                  className="h-full rounded-full bg-gray-700 transition-[width]"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {missing && (
                <PillButtonUI tone="black" size="sm" onClick={() => void download()}>
                  Download speech models
                </PillButtonUI>
              )}
              {installed && (
                <PillButtonUI tone="white" size="sm" loading={removing} onClick={() => void remove()}>
                  Remove voice mode models
                </PillButtonUI>
              )}
            </div>
          )}
          {failed && (
            <p className="text-sm text-red-600" role="alert">
              {failed}
            </p>
          )}
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}
