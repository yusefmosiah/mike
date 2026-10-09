"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Mic, Play, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownCheckboxItem,
  LiquidDropdownContent,
} from "@/app/components/ui/liquid-dropdown";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  synthesizeSpeechDetailed,
  transcribeAudio,
  type VoiceCatalogModel,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { speakWithBrowser } from "@/app/lib/voice/browserSpeech";
import {
  hasBrowserModelConsent,
  speakWithBrowserModel,
  transcribeInBrowser,
} from "@/app/lib/voice/browserModels";
import { formatUsd, formatVoicePrice } from "@/app/lib/voice/pricing";
import type { VoiceAvailability } from "@/app/lib/voice/preferences";

/** At most this many OpenRouter models per run, so one click costs little. */
export const MAX_COMPARED_OPENROUTER_MODELS = 4;
const DEFAULT_SENTENCE =
  "The quarterly report shows the North region ahead of plan by ten percent.";

type Candidate = {
  key: string;
  label: string;
  engine: "operator" | "openrouter" | "browser" | "webgpu";
  model?: string;
};

type Row = {
  key: string;
  label: string;
  status: "running" | "done" | "failed";
  latencyMs?: number;
  /** null: unknown; undefined: on this device. */
  costUsd?: number | null;
  transcript?: string;
  audioUrl?: string;
  error?: string;
};

function costLabel(row: Row): string {
  if (row.costUsd === undefined) return "On this device";
  if (row.costUsd === null) return "Cost not reported";
  return formatUsd(row.costUsd);
}

function ModelPicker({
  label,
  models,
  selected,
  onChange,
}: {
  label: string;
  models: VoiceCatalogModel[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`flex min-h-9 items-center justify-between gap-2 py-1.5 text-left hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${SETTINGS_CONTROL_CLASS}`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere] text-gray-900">
            {selected.length === 0
              ? "No OpenRouter models"
              : `${selected.length} OpenRouter model${selected.length === 1 ? "" : "s"}`}
          </span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        </button>
      </DropdownMenuTrigger>
      <LiquidDropdownContent
        className="z-50 max-h-80 overflow-y-auto"
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        {models.map((model) => {
          const checked = selected.includes(model.id);
          return (
            <LiquidDropdownCheckboxItem
              key={model.id}
              checked={checked}
              disabled={!checked && selected.length >= MAX_COMPARED_OPENROUTER_MODELS}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) =>
                onChange(next ? [...selected, model.id] : selected.filter((id) => id !== model.id))
              }
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block">{model.name}</span>
                <span className="block text-[11px] text-gray-400">{formatVoicePrice(model.price)}</span>
              </span>
            </LiquidDropdownCheckboxItem>
          );
        })}
      </LiquidDropdownContent>
    </DropdownMenu>
  );
}

function Results({ rows, kind }: { rows: Row[]; kind: "speech" | "transcription" }) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label={kind === "speech" ? "Speech results" : "Transcription results"}>
      {rows.map((row) => (
        <li key={row.key} className="rounded-lg bg-gray-50 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-sm font-medium text-gray-800 [overflow-wrap:anywhere]">{row.label}</p>
            <p className="text-xs text-gray-500">
              {row.status === "running"
                ? "Running…"
                : row.status === "failed"
                  ? "Failed"
                  : `${row.latencyMs !== undefined ? `${(row.latencyMs / 1000).toFixed(1)} s · ` : ""}${costLabel(row)}`}
            </p>
          </div>
          {row.error && <p className="mt-1 text-sm text-red-600">{row.error}</p>}
          {row.transcript !== undefined && (
            <p className="mt-1 text-sm text-gray-700 [overflow-wrap:anywhere]">
              {row.transcript || "(no words recognised)"}
            </p>
          )}
          {row.audioUrl && (
            <PillButtonUI
              tone="white"
              size="xs"
              className="mt-1"
              onClick={() => void new Audio(row.audioUrl).play()}
            >
              <Play aria-hidden="true" className="h-3 w-3" />
              Play
            </PillButtonUI>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → Voice test bench: one sentence through several speech engines,
 * or one recording through several transcription engines, side by side with
 * latency and cost. The recording and the audio live only in this page.
 */
export function VoiceTestBench({
  availability,
  catalog,
}: {
  availability: VoiceAvailability;
  catalog: { speech: VoiceCatalogModel[]; transcription: VoiceCatalogModel[] } | null;
}) {
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE);
  const [speechModels, setSpeechModels] = useState<string[]>([]);
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [speechRows, setSpeechRows] = useState<Row[]>([]);
  const [sttRows, setSttRows] = useState<Row[]>([]);
  const [clip, setClip] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [running, setRunning] = useState<"speech" | "transcription" | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(
    () => () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const nameOf = (models: VoiceCatalogModel[] | undefined, id: string) =>
    models?.find((model) => model.id === id)?.name ?? id;

  const speechCandidates: Candidate[] = [
    ...(availability.operatorSpeech ? [{ key: "operator", label: "This server", engine: "operator" as const }] : []),
    ...(availability.browserSpeech ? [{ key: "browser", label: "This browser's voices", engine: "browser" as const }] : []),
    ...(availability.webgpu && hasBrowserModelConsent("speech")
      ? [{ key: "webgpu", label: "Kokoro 82M in this browser", engine: "webgpu" as const }]
      : []),
    ...speechModels.map((id) => ({ key: `or:${id}`, label: `OpenRouter: ${nameOf(catalog?.speech, id)}`, engine: "openrouter" as const, model: id })),
  ];
  const sttCandidates: Candidate[] = [
    ...(availability.operatorTranscription ? [{ key: "operator", label: "This server", engine: "operator" as const }] : []),
    ...(availability.webgpu && hasBrowserModelConsent("transcription")
      ? [{ key: "webgpu", label: "Whisper Base in this browser", engine: "webgpu" as const }]
      : []),
    ...sttModels.map((id) => ({ key: `or:${id}`, label: `OpenRouter: ${nameOf(catalog?.transcription, id)}`, engine: "openrouter" as const, model: id })),
  ];

  const update = (setRows: typeof setSpeechRows, key: string, patch: Partial<Row>) =>
    setRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const runSpeech = async () => {
    const text = sentence.trim().slice(0, 300);
    if (!text) return;
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = [];
    setRunning("speech");
    setSpeechRows(speechCandidates.map((c) => ({ key: c.key, label: c.label, status: "running" })));
    for (const candidate of speechCandidates) {
      const started = performance.now();
      try {
        if (candidate.engine === "browser") {
          await speakWithBrowser(text);
          update(setSpeechRows, candidate.key, { status: "done", latencyMs: performance.now() - started, costUsd: undefined });
          continue;
        }
        let blob: Blob;
        let cost: number | null | undefined;
        if (candidate.engine === "webgpu") {
          blob = await speakWithBrowserModel(text);
          cost = undefined;
        } else {
          const spoken = await synthesizeSpeechDetailed(
            text,
            candidate.engine === "openrouter" ? { provider: "openrouter", model: candidate.model } : undefined,
          );
          blob = spoken.blob;
          cost = spoken.costUsd;
        }
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        update(setSpeechRows, candidate.key, { status: "done", latencyMs: performance.now() - started, costUsd: cost, audioUrl: url });
      } catch (error) {
        update(setSpeechRows, candidate.key, { status: "failed", error: userFacingApiError(error, "This engine could not speak the sentence.") });
      }
    }
    setRunning(null);
  };

  const record = async () => {
    setRecordError(null);
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType });
        setClip(blob.size > 0 ? blob : null);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecordError("Could not start recording. Check microphone access.");
    }
  };

  const runTranscription = async () => {
    if (!clip) return;
    setRunning("transcription");
    setSttRows(sttCandidates.map((c) => ({ key: c.key, label: c.label, status: "running" })));
    for (const candidate of sttCandidates) {
      const started = performance.now();
      try {
        if (candidate.engine === "webgpu") {
          const text = await transcribeInBrowser(clip);
          update(setSttRows, candidate.key, { status: "done", latencyMs: performance.now() - started, costUsd: undefined, transcript: text });
          continue;
        }
        const result = await transcribeAudio(
          clip,
          candidate.engine === "openrouter" ? { provider: "openrouter", model: candidate.model } : undefined,
        );
        update(setSttRows, candidate.key, {
          status: "done",
          latencyMs: performance.now() - started,
          costUsd: result.cost_usd ?? null,
          transcript: result.text,
        });
      } catch (error) {
        update(setSttRows, candidate.key, { status: "failed", error: userFacingApiError(error, "This engine could not transcribe the recording.") });
      }
    }
    setRunning(null);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="space-y-1">
          <SettingsLabel>Read a sentence aloud</SettingsLabel>
          <SettingsDescription>
            Runs the sentence through each engine below in turn. OpenRouter calls are billed to
            this deployment&apos;s key; up to {MAX_COMPARED_OPENROUTER_MODELS} models per run.
          </SettingsDescription>
        </div>
        <textarea
          aria-label="Sentence to read aloud"
          value={sentence}
          maxLength={300}
          rows={2}
          onChange={(event) => setSentence(event.target.value)}
          className={`keyboard-focus-ring resize-none py-2 ${SETTINGS_CONTROL_CLASS}`}
        />
        {catalog && (
          <ModelPicker label="OpenRouter speech models to compare" models={catalog.speech} selected={speechModels} onChange={setSpeechModels} />
        )}
        <PillButtonUI
          tone="black"
          size="sm"
          loading={running === "speech"}
          disabled={running !== null || speechCandidates.length === 0 || !sentence.trim()}
          onClick={() => void runSpeech()}
        >
          Compare {speechCandidates.length} engine{speechCandidates.length === 1 ? "" : "s"}
        </PillButtonUI>
        <Results rows={speechRows} kind="speech" />
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <SettingsLabel>Transcribe one recording</SettingsLabel>
          <SettingsDescription>
            Record a few seconds once, then send the same clip to each engine. The browser&apos;s
            own recognition listens live, so try it from the chat composer instead.
          </SettingsDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PillButtonUI tone={recording ? "danger" : "white"} size="sm" onClick={() => void record()} aria-pressed={recording}>
            {recording ? <Square aria-hidden="true" className="h-3 w-3" /> : <Mic aria-hidden="true" className="h-3 w-3" />}
            {recording ? "Stop recording" : clip ? "Record again" : "Record a clip"}
          </PillButtonUI>
          {clip && !recording && <p className="text-sm text-gray-500">Clip ready.</p>}
        </div>
        {recordError && (
          <p className="text-sm text-red-600" role="alert">
            {recordError}
          </p>
        )}
        {catalog && (
          <ModelPicker label="OpenRouter transcription models to compare" models={catalog.transcription} selected={sttModels} onChange={setSttModels} />
        )}
        <PillButtonUI
          tone="black"
          size="sm"
          loading={running === "transcription"}
          disabled={running !== null || !clip || sttCandidates.length === 0}
          onClick={() => void runTranscription()}
        >
          Compare {sttCandidates.length} engine{sttCandidates.length === 1 ? "" : "s"}
        </PillButtonUI>
        <Results rows={sttRows} kind="transcription" />
      </div>
    </div>
  );
}
