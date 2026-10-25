"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { useVoicePreferences } from "@/app/lib/voice/preferences";
import { VOICE_REMOVE_FAILURE_MESSAGE, voiceRemove } from "@/app/lib/voice/voiceEngine";

/**
 * Voice mode's settings in a browser (docs/voice-web.md). Nothing here loads
 * or probes voice mode's engine until the person asks for something: its
 * models download the first time voice mode starts, after the person agrees.
 */
export function WebVoiceModeSetup({ serverSpeechAvailable }: { serverSpeechAvailable: boolean }) {
  const [preferences, setPreferences] = useVoicePreferences();
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const speakSteps = preferences.speakSteps !== false;
  const serverSpeech = preferences.voiceMode?.serverSpeech === true;

  const remove = async () => {
    setFailed(null);
    setRemoved(false);
    setRemoving(true);
    try {
      await voiceRemove();
      setRemoved(true);
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
            <SettingsLabel>In this browser</SettingsLabel>
            <SettingsDescription>
              Voice mode runs in this browser. The speech models it needs download the first time you start it, and what you
              say stays here. Voice mode does not listen while it speaks: tap to interrupt.
            </SettingsDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <PillButtonUI tone="white" size="sm" loading={removing} onClick={() => void remove()}>
              Remove voice mode downloads
            </PillButtonUI>
          </div>
          <div role="status" aria-live="polite" className="empty:hidden">
            {removed && <p className="text-sm text-gray-700">Removed. They download again the next time you start voice mode.</p>}
          </div>
          {failed && (
            <p className="text-sm text-red-600" role="alert">
              {failed}
            </p>
          )}
        </SettingsRow>
        {serverSpeechAvailable && (
          <SettingsRow layout="stacked">
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Speech server</SettingsLabel>
              <SettingsDescription>
                Where this browser cannot turn speech into text itself (on some phones and tablets), voice mode can send what
                you say to this workspace’s speech server instead. Off unless you allow it.
              </SettingsDescription>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Speech server for voice mode">
              {[
                { value: false, label: "This device only" },
                { value: true, label: "Allow the speech server" },
              ].map((option) => (
                <PillButtonUI
                  key={option.label}
                  tone={serverSpeech === option.value ? "black" : "white"}
                  size="sm"
                  aria-pressed={serverSpeech === option.value}
                  onClick={() =>
                    setPreferences({ ...preferences, voiceMode: { ...preferences.voiceMode, serverSpeech: option.value } })
                  }
                >
                  {option.label}
                </PillButtonUI>
              ))}
            </div>
          </SettingsRow>
        )}
        <SettingsRow layout="stacked">
          <div className="min-w-0 space-y-1">
            <SettingsLabel>While it works</SettingsLabel>
            <SettingsDescription>
              When an answer takes a while, voice mode can say what the assistant is doing, a short line at a time, so the
              wait is not silent.
            </SettingsDescription>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="While it works">
            {[
              { value: true, label: "Say what it is doing" },
              { value: false, label: "Stay quiet" },
            ].map((option) => (
              <PillButtonUI
                key={option.label}
                tone={speakSteps === option.value ? "black" : "white"}
                size="sm"
                aria-pressed={speakSteps === option.value}
                onClick={() => setPreferences({ ...preferences, speakSteps: option.value })}
              >
                {option.label}
              </PillButtonUI>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}
