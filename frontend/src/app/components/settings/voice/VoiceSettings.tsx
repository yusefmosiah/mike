"use client";

import { useEffect, useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import {
  browserVoices,
  installOnDeviceRecognition,
} from "@/app/lib/voice/browserSpeech";
import {
  DEFAULT_KOKORO_VOICE,
  browserModelVoices,
} from "@/app/lib/voice/browserModels";
import { formatVoicePrice } from "@/app/lib/voice/pricing";
import {
  VOICE_ENGINES,
  engineAvailable,
  useVoicePreferences,
  type VoiceEngine,
} from "@/app/lib/voice/preferences";
import { BrowserModelSetup } from "./BrowserModelSetup";
import { useVoiceAvailability } from "./useVoiceAvailability";
import { VoiceChoiceDropdown, type VoiceChoice } from "./VoiceChoiceDropdown";
import { VoiceTestBench } from "./VoiceTestBench";

/** Why the saved choice cannot run here, if it cannot. */
function unavailableReason(engine: VoiceEngine): string {
  switch (engine) {
    case "operator":
      return "This deployment has no speech server configured.";
    case "openrouter":
      return "OpenRouter is not available on this deployment.";
    case "browser":
      return "This browser cannot do this on the device.";
    case "webgpu":
      return "This browser cannot run the open model.";
  }
}

const ENGINE_LABELS: Record<VoiceEngine, string> = {
  operator: "This server",
  openrouter: "OpenRouter",
  browser: "This browser",
  webgpu: "Open model in browser",
};

function EnginePills({
  kind,
  value,
  available,
  onChange,
}: {
  kind: "transcription" | "speech";
  value: VoiceEngine;
  available: (engine: VoiceEngine) => boolean;
  onChange: (engine: VoiceEngine) => void;
}) {
  return (
    <div role="group" aria-label={kind === "transcription" ? "Dictation engine" : "Read-aloud engine"} className="flex flex-wrap gap-1.5">
      {VOICE_ENGINES.filter(available).map((engine) => (
        <TabPillButtonUI key={engine} active={engine === value} onClick={() => onChange(engine)}>
          {ENGINE_LABELS[engine]}
        </TabPillButtonUI>
      ))}
    </div>
  );
}

/** Settings → Voice: engines, models, voices and a side-by-side test bench. */
export function VoiceSettings() {
  const [preferences, setPreferences] = useVoicePreferences();
  const { options, availability, recognitionStatus, refreshRecognition, loading, error } = useVoiceAvailability();
  const [systemVoices, setSystemVoices] = useState<VoiceChoice[]>([]);
  const [kokoroVoices, setKokoroVoices] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const catalog = options?.openrouter.available ? options.openrouter.catalog : null;
  const stt = preferences.transcription;
  const tts = preferences.speech;

  useEffect(() => {
    if (tts.engine !== "browser") return;
    void browserVoices().then((voices) =>
      setSystemVoices(voices.map((v) => ({ id: v.voiceURI, label: v.name, detail: `${v.lang}${v.localService ? " · on this device" : " · online"}` }))),
    );
  }, [tts.engine]);

  useEffect(() => {
    if (tts.engine !== "webgpu") return;
    void browserModelVoices().then(setKokoroVoices).catch(() => setKokoroVoices([DEFAULT_KOKORO_VOICE]));
  }, [tts.engine]);

  if (loading) {
    return (
      <div className="space-y-8" aria-busy="true">
        {[0, 1].map((i) => (
          <section key={i} className="space-y-3">
            <div className="h-5 w-32 animate-pulse rounded bg-gray-100" />
            <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
          </section>
        ))}
      </div>
    );
  }

  const sttModels = catalog?.transcription ?? [];
  const ttsModels = catalog?.speech ?? [];
  const ttsModel = ttsModels.find((m) => m.id === tts.model);
  const unavailableNote = options?.strict_private
    ? "OpenRouter is off: this deployment runs in strict private mode."
    : options?.openrouter.available === false
      ? "OpenRouter is not configured on this deployment."
      : null;

  return (
    <div className="space-y-8">
      {error && (
        <p className="text-sm text-red-600" role="alert">
          Could not load this server&apos;s voice options. Engines in this browser still work.
        </p>
      )}
      <section className="space-y-3">
        <SettingsHeading>Dictation</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Engine</SettingsLabel>
              <SettingsDescription>Turns what you say into text in the message box. It never sends the message.</SettingsDescription>
            </div>
            <EnginePills
              kind="transcription"
              value={stt.engine}
              available={(engine) => engineAvailable("transcription", engine, availability)}
              onChange={(engine) => setPreferences({ ...preferences, transcription: { ...stt, engine } })}
            />
            {!engineAvailable("transcription", stt.engine, availability) && (
              <p className="text-sm text-gray-700" role="status">
                {unavailableReason(stt.engine)} Choose an engine above.
              </p>
            )}
            {unavailableNote && <SettingsDescription>{unavailableNote}</SettingsDescription>}
          </SettingsRow>
          {stt.engine === "operator" && options?.operator.transcription && (
            <SettingsRow>
              <SettingsDescription>Uses {options.operator.transcription.model} on this deployment&apos;s speech server.</SettingsDescription>
            </SettingsRow>
          )}
          {stt.engine === "openrouter" && (
            <SettingsRow layout="stacked">
              <SettingsLabel>Model</SettingsLabel>
              <VoiceChoiceDropdown
                label="Dictation model"
                value={stt.model}
                placeholder="Choose a model"
                choices={sttModels.map((m) => ({ id: m.id, label: m.name, detail: formatVoicePrice(m.price) }))}
                onChange={(model) => setPreferences({ ...preferences, transcription: { ...stt, model } })}
              />
              <SettingsDescription>For comparing models while testing. Recordings go to OpenRouter and the provider it routes to.</SettingsDescription>
            </SettingsRow>
          )}
          {stt.engine === "browser" && (
            <SettingsRow>
              <SettingsDescription>
                {recognitionStatus === "available"
                  ? "Recognition runs on this device; nothing is sent anywhere."
                  : recognitionStatus === "downloading"
                    ? "The language pack is downloading."
                    : "This browser can recognise speech on this device after installing a language pack."}
              </SettingsDescription>
              {recognitionStatus === "downloadable" && (
                <PillButtonUI
                  tone="white"
                  size="sm"
                  loading={installing}
                  onClick={async () => {
                    setInstalling(true);
                    await installOnDeviceRecognition();
                    setInstalling(false);
                    refreshRecognition();
                  }}
                >
                  Install language pack
                </PillButtonUI>
              )}
            </SettingsRow>
          )}
          {stt.engine === "webgpu" && (
            <SettingsRow layout="stacked">
              <BrowserModelSetup kind="transcription" />
            </SettingsRow>
          )}
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Read aloud</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Engine</SettingsLabel>
              <SettingsDescription>Reads answers aloud when you press play on a message.</SettingsDescription>
            </div>
            <EnginePills
              kind="speech"
              value={tts.engine}
              available={(engine) => engineAvailable("speech", engine, availability)}
              onChange={(engine) => setPreferences({ ...preferences, speech: { engine } })}
            />
            {!engineAvailable("speech", tts.engine, availability) && (
              <p className="text-sm text-gray-700" role="status">
                {unavailableReason(tts.engine)} Choose an engine above.
              </p>
            )}
            {unavailableNote && <SettingsDescription>{unavailableNote}</SettingsDescription>}
          </SettingsRow>
          {tts.engine === "operator" && options?.operator.speech && (
            <SettingsRow>
              <SettingsDescription>
                Uses {options.operator.speech.model} with the voice {options.operator.speech.voice} on this deployment&apos;s speech server.
              </SettingsDescription>
            </SettingsRow>
          )}
          {tts.engine === "openrouter" && (
            <SettingsRow layout="stacked">
              <SettingsLabel>Model</SettingsLabel>
              <VoiceChoiceDropdown
                label="Read-aloud model"
                value={tts.model}
                placeholder="Choose a model"
                choices={ttsModels.map((m) => ({ id: m.id, label: m.name, detail: formatVoicePrice(m.price) }))}
                onChange={(model) => setPreferences({ ...preferences, speech: { engine: "openrouter", model } })}
              />
              {ttsModel && ttsModel.voices.length > 0 && (
                <>
                  <SettingsLabel>Voice</SettingsLabel>
                  <VoiceChoiceDropdown
                    label="Read-aloud voice"
                    value={tts.voice ?? ttsModel.voices[0]}
                    placeholder="Choose a voice"
                    choices={ttsModel.voices.map((v) => ({ id: v, label: v }))}
                    onChange={(voice) => setPreferences({ ...preferences, speech: { ...tts, voice } })}
                  />
                </>
              )}
              <SettingsDescription>For comparing models while testing. Answer text goes to OpenRouter and the provider it routes to.</SettingsDescription>
            </SettingsRow>
          )}
          {tts.engine === "browser" && (
            <SettingsRow layout="stacked">
              <SettingsLabel>Voice</SettingsLabel>
              <VoiceChoiceDropdown
                label="Read-aloud voice"
                value={tts.voice}
                placeholder="The system default voice"
                choices={systemVoices}
                onChange={(voice) => setPreferences({ ...preferences, speech: { engine: "browser", voice } })}
              />
              <SettingsDescription>Voices marked &quot;online&quot; are run by the browser&apos;s maker, not on this device.</SettingsDescription>
            </SettingsRow>
          )}
          {tts.engine === "webgpu" && (
            <SettingsRow layout="stacked">
              <BrowserModelSetup kind="speech" />
              <SettingsLabel>Voice</SettingsLabel>
              <VoiceChoiceDropdown
                label="Read-aloud voice"
                value={tts.voice ?? DEFAULT_KOKORO_VOICE}
                placeholder="Choose a voice"
                choices={kokoroVoices.map((v) => ({ id: v, label: v }))}
                onChange={(voice) => setPreferences({ ...preferences, speech: { engine: "webgpu", voice } })}
              />
            </SettingsRow>
          )}
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Test bench</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <VoiceTestBench availability={availability} catalog={catalog} />
          </SettingsRow>
        </SettingsCard>
      </section>
    </div>
  );
}
