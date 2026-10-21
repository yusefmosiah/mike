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
  PHONON_ENGINE,
  deviceVoices,
  installDeviceSpeech,
  speakOnDevice,
  isEnglishLanguage,
  type DeviceDictationModel,
  type DeviceSpeechModel,
} from "@/app/lib/voice/deviceSpeech";
import {
  DEFAULT_KOKORO_VOICE,
  DEFAULT_PHONON_VOICE,
  PHONON_MODEL_CARD_URL,
  PHONON_VOICES,
  browserModelVoices,
  browserSpeechKind,
  browserSpeechModel,
  hasBrowserModelConsent,
  isPhononVoice,
  speakWithBrowserModel,
  type BrowserSpeechModel,
} from "@/app/lib/voice/browserModels";
import { formatVoicePrice } from "@/app/lib/voice/pricing";
import {
  VOICE_ENGINES,
  engineAvailable,
  useVoicePreferences,
  type VoiceEngine,
} from "@/app/lib/voice/preferences";
import { BrowserModelSetup } from "./BrowserModelSetup";
import { PhononPhoneSetup } from "./PhononPhoneSetup";
import { PhononVoiceList } from "./PhononVoiceList";
import { useVoiceAvailability } from "./useVoiceAvailability";
import { VoiceChoiceDropdown, type VoiceChoice } from "./VoiceChoiceDropdown";
import { VoiceModeSetup } from "./VoiceModeSetup";
import { VoiceTestBench } from "./VoiceTestBench";
import { VocabularySection } from "./VocabularySection";

/** Why the saved choice cannot run here, if it cannot. */
function unavailableReason(engine: VoiceEngine): string {
  switch (engine) {
    case "device":
      return "Apple's speech on the phone needs the iPhone app (an up-to-date build to read aloud).";
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

const DEVICE_MODEL_CHOICES: readonly { model: DeviceDictationModel; label: string }[] = [
  { model: "fluid-speech-mini", label: "Fluid Speech Mini" },
  { model: "apple", label: "Apple" },
];

const DEVICE_SPEECH_CHOICES: readonly { model: DeviceSpeechModel; label: string }[] = [
  { model: "phonon", label: "Phonon" },
  { model: "apple", label: "Apple" },
];

const BROWSER_SPEECH_CHOICES: readonly { model: BrowserSpeechModel; label: string }[] = [
  { model: "phonon", label: "Phonon" },
  { model: "kokoro", label: "Kokoro" },
];

const CREDIT_LINK_CLASS =
  "underline underline-offset-2 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900";

/** The credit Phonon's licence (Apache-2.0) asks for, linking the model card. */
function PhononCredit() {
  return (
    <SettingsRow>
      <SettingsDescription>
        <a href={PHONON_MODEL_CARD_URL} target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>
          Phonon by Gradium
        </a>{" "}
        (Apache-2.0). Built on Kyutai&apos;s Pocket TTS.
      </SettingsDescription>
    </SettingsRow>
  );
}

/** The licence of Fluid Speech Mini (CC BY 4.0), which asks for this credit. */
const FLUID_SPEECH_MINI_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

const ENGINE_LABELS: Record<VoiceEngine, string> = {
  device: "This iPhone",
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
  const { options, availability, recognitionStatus, refreshRecognition, deviceStatus, refreshDevice, fluidSpeechMini, phonon, refreshPhonon, loading, error } =
    useVoiceAvailability();
  const [systemVoices, setSystemVoices] = useState<VoiceChoice[]>([]);
  const [kokoroVoices, setKokoroVoices] = useState<string[]>([]);
  const [phoneVoices, setPhoneVoices] = useState<VoiceChoice[]>([]);
  const [installing, setInstalling] = useState(false);
  const [phononConsent, setPhononConsent] = useState(() => hasBrowserModelConsent("phonon"));
  const catalog = options?.openrouter.available ? options.openrouter.catalog : null;
  const stt = preferences.transcription;
  const tts = preferences.speech;
  const deviceModel: DeviceDictationModel =
    fluidSpeechMini && stt.model !== "apple" ? "fluid-speech-mini" : "apple";
  // What dictation will actually use: the model is English only.
  const usesFluid = fluidSpeechMini && deviceModel === "fluid-speech-mini" && isEnglishLanguage(stt.language);

  // The phone reads with Phonon when it is chosen, or, with no choice, once it is downloaded.
  const phoneSpeechModel: DeviceSpeechModel =
    phonon.state === "unavailable" || tts.model === "apple" ? "apple" : tts.model === "phonon" || phonon.state === "available" ? "phonon" : "apple";
  const browserModel = browserSpeechModel(tts.model);

  useEffect(() => {
    if (tts.engine !== "browser") return;
    void browserVoices().then((voices) =>
      setSystemVoices(voices.map((v) => ({ id: v.voiceURI, label: v.name, detail: `${v.lang}${v.localService ? " · on this device" : " · online"}` }))),
    );
  }, [tts.engine]);

  useEffect(() => {
    if (tts.engine !== "device") return;
    void deviceVoices().then((voices) =>
      setPhoneVoices(
        voices.map((v) => ({
          id: v.id,
          label: v.name,
          detail: v.quality === "default" ? v.language : `${v.language} · ${v.quality}`,
        })),
      ),
    );
  }, [tts.engine]);

  useEffect(() => {
    if (tts.engine !== "webgpu" || browserModel !== "kokoro") return;
    void browserModelVoices().then(setKokoroVoices).catch(() => setKokoroVoices([DEFAULT_KOKORO_VOICE]));
  }, [tts.engine, browserModel]);

  if (loading) {
    return (
      <div className="space-y-8" aria-busy="true">
        {[0, 1, 2].map((i) => (
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
              onChange={(engine) => {
                // The model belongs to the engine that named it.
                const { model, ...rest } = stt;
                const keep = model !== "fluid-speech-mini" && model !== "apple" ? { model } : {};
                setPreferences({ ...preferences, transcription: { ...rest, ...keep, engine } });
              }}
            />
            {!engineAvailable("transcription", stt.engine, availability) && (
              <p className="text-sm text-gray-700" role="status">
                {unavailableReason(stt.engine)} Choose an engine above.
              </p>
            )}
            {unavailableNote && <SettingsDescription>{unavailableNote}</SettingsDescription>}
          </SettingsRow>
          {stt.engine === "device" && availability.deviceRecognition && (
            <>
              {fluidSpeechMini && deviceStatus !== "unavailable" && (
                <SettingsRow layout="stacked">
                  <div className="min-w-0 space-y-1">
                    <SettingsLabel>Recognizer</SettingsLabel>
                    <SettingsDescription>
                      Fluid Speech Mini understands English only; other languages use Apple&apos;s.
                    </SettingsDescription>
                  </div>
                  <div role="group" aria-label="Dictation recognizer" className="flex flex-wrap gap-1.5">
                    {DEVICE_MODEL_CHOICES.map(({ model, label }) => (
                      <TabPillButtonUI
                        key={model}
                        active={deviceModel === model}
                        onClick={() => setPreferences({ ...preferences, transcription: { ...stt, model } })}
                      >
                        {label}
                      </TabPillButtonUI>
                    ))}
                  </div>
                </SettingsRow>
              )}
              {usesFluid ? (
                <SettingsRow>
                  <SettingsDescription>
                    Fluid Speech Mini runs on this iPhone and works offline; the recording never leaves it.
                  </SettingsDescription>
                </SettingsRow>
              ) : (
                <SettingsRow>
                  <SettingsDescription>
                    {deviceStatus === "available"
                      ? "Apple's speech recognition runs on this iPhone; the recording never leaves it."
                      : deviceStatus === "downloading"
                        ? "Apple's speech model for this language is downloading."
                        : "This iPhone can transcribe on the device after downloading Apple's speech model for this language."}
                  </SettingsDescription>
                  {deviceStatus === "downloadable" && (
                    <PillButtonUI
                      tone="white"
                      size="sm"
                      loading={installing}
                      onClick={async () => {
                        setInstalling(true);
                        await installDeviceSpeech(stt.language);
                        setInstalling(false);
                        refreshDevice();
                      }}
                    >
                      Download speech model
                    </PillButtonUI>
                  )}
                </SettingsRow>
              )}
            </>
          )}
          {fluidSpeechMini && (
            <SettingsRow>
              <SettingsDescription>
                <a
                  href={FLUID_SPEECH_MINI_LICENSE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                  Fluid Speech Mini by FluidVoice
                </a>{" "}
                (CC BY 4.0). Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.
              </SettingsDescription>
            </SettingsRow>
          )}
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

      <VocabularySection />

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
              onChange={(engine) =>
                // The in-browser engine starts on Phonon; a stored choice without a model stays Kokoro.
                setPreferences({ ...preferences, speech: engine === "webgpu" ? { engine, model: "phonon" } : { engine } })
              }
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
          {tts.engine === "device" && engineAvailable("speech", "device", availability) && (
            <>
              {phonon.state !== "unavailable" && (
                <SettingsRow layout="stacked">
                  <div className="min-w-0 space-y-1">
                    <SettingsLabel>Voices</SettingsLabel>
                    <SettingsDescription>Phonon reads English only; other languages use Apple&apos;s voices.</SettingsDescription>
                  </div>
                  <div role="group" aria-label="Read-aloud voices" className="flex flex-wrap gap-1.5">
                    {DEVICE_SPEECH_CHOICES.map(({ model, label }) => (
                      <TabPillButtonUI
                        key={model}
                        active={phoneSpeechModel === model}
                        onClick={() =>
                          // A voice belongs to the model that offers it.
                          setPreferences({ ...preferences, speech: { engine: "device", model } })
                        }
                      >
                        {label}
                      </TabPillButtonUI>
                    ))}
                  </div>
                  <PhononPhoneSetup status={phonon} chosen={phoneSpeechModel === "phonon"} onChange={refreshPhonon} />
                </SettingsRow>
              )}
              <SettingsRow layout="stacked">
                <SettingsLabel>Voice</SettingsLabel>
                {phoneSpeechModel === "phonon" ? (
                  <PhononVoiceList
                    voices={PHONON_VOICES}
                    value={isPhononVoice(tts.voice) ? tts.voice : DEFAULT_PHONON_VOICE}
                    engine="device"
                    synthesize={(text, voice) => speakOnDevice(text, voice, PHONON_ENGINE)}
                    preparing={phonon.state === "available" && !!phonon.compiling}
                    playDisabledReason={
                      phonon.state === "available" ? undefined : "Download Phonon above to hear samples. You can still choose a voice."
                    }
                    onSelect={(voice) =>
                      setPreferences({ ...preferences, speech: { engine: "device", model: "phonon", voice } })
                    }
                  />
                ) : (
                  <VoiceChoiceDropdown
                    label="Read-aloud voice"
                    value={tts.voice}
                    placeholder="The iPhone's default voice"
                    choices={phoneVoices}
                    onChange={(voice) =>
                      setPreferences({
                        ...preferences,
                        speech: { engine: "device", ...(tts.model ? { model: tts.model } : {}), voice },
                      })
                    }
                  />
                )}
                {phoneSpeechModel !== "phonon" && (
                  <SettingsDescription>
                    Apple&apos;s voices read on this iPhone; the text never leaves it. Better voices (enhanced, premium) can be downloaded in the iPhone&apos;s Accessibility settings, under spoken content.
                  </SettingsDescription>
                )}
              </SettingsRow>
              {phonon.state !== "unavailable" && <PhononCredit />}
            </>
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
            <>
              <SettingsRow layout="stacked">
                <SettingsLabel>Model</SettingsLabel>
                <div role="group" aria-label="Read-aloud model" className="flex flex-wrap gap-1.5">
                  {BROWSER_SPEECH_CHOICES.map(({ model, label }) => (
                    <TabPillButtonUI
                      key={model}
                      active={browserModel === model}
                      onClick={() => setPreferences({ ...preferences, speech: { engine: "webgpu", model } })}
                    >
                      {label}
                    </TabPillButtonUI>
                  ))}
                </div>
                <BrowserModelSetup
                  key={browserSpeechKind(tts.model)}
                  kind={browserSpeechKind(tts.model)}
                  onReadyChange={browserModel === "phonon" ? setPhononConsent : undefined}
                />
                <SettingsLabel>Voice</SettingsLabel>
                {browserModel === "phonon" ? (
                  <PhononVoiceList
                    voices={PHONON_VOICES}
                    value={isPhononVoice(tts.voice) ? tts.voice : DEFAULT_PHONON_VOICE}
                    engine="webgpu"
                    synthesize={(text, voice) => speakWithBrowserModel(text, { voice, model: "phonon" })}
                    playDisabledReason={
                      phononConsent ? undefined : "Set up Phonon above to hear samples. You can still choose a voice."
                    }
                    onSelect={(voice) => setPreferences({ ...preferences, speech: { engine: "webgpu", model: "phonon", voice } })}
                  />
                ) : (
                  <VoiceChoiceDropdown
                    label="Read-aloud voice"
                    value={tts.voice ?? DEFAULT_KOKORO_VOICE}
                    placeholder="Choose a voice"
                    choices={kokoroVoices.map((v) => ({ id: v, label: v }))}
                    onChange={(voice) => setPreferences({ ...preferences, speech: { engine: "webgpu", model: "kokoro", voice } })}
                  />
                )}
              </SettingsRow>
              {browserModel === "phonon" && <PhononCredit />}
            </>
          )}
        </SettingsCard>
      </section>

      <VoiceModeSetup />

      <section className="space-y-3">
        <SettingsHeading>Test bench</SettingsHeading>
        <SettingsCard>
          <SettingsRow layout="stacked">
            <VoiceTestBench
              availability={availability}
              fluidSpeechMini={fluidSpeechMini}
              appleDictation={deviceStatus !== "unavailable"}
              catalog={catalog}
            />
          </SettingsRow>
        </SettingsCard>
      </section>
    </div>
  );
}
