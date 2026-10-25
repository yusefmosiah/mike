import type { AssistantEvent } from "@/app/components/shared/types";
import { SpeakableStream } from "./speakable";

/**
 * In voice mode, what the assistant is doing is said while it works, from the
 * step summaries (docs/voice-chat.md, "Speaking while it works"): otherwise a
 * long run is silence. Only the newest step of the current run is said, never
 * one from before the answer's last words, and never over the answer.
 */

/** Gap between two spoken steps, so the person hears progress, not a list. */
export const STEP_GAP_MS = 6_000;
/** A spoken step is one short sentence. */
export const MAX_SPOKEN_STEP_CHARS = 160;

export type StepToSay = { key: string; text: string };

function summaryOf(event: AssistantEvent): string | undefined {
    if (event.type === "code_cell" || event.type === "reasoning") return event.summary?.text.trim() || undefined;
    return undefined;
}

function keyOf(event: AssistantEvent, index: number): string {
    if (event.type === "code_cell") return `cell:${event.call_id}`;
    if (event.type === "reasoning" && event.id) return `reasoning:${event.id}`;
    return `event:${index}`;
}

/**
 * The steps of the run in progress that have a summary, oldest first: those
 * after the answer's last text. None once text is the last thing written.
 */
export function currentSteps(events: readonly AssistantEvent[]): StepToSay[] {
    let start = 0;
    events.forEach((event, index) => {
        if (event.type === "content" && event.text.trim()) start = index + 1;
    });
    const steps: StepToSay[] = [];
    for (let index = start; index < events.length; index++) {
        const text = summaryOf(events[index]);
        if (text) steps.push({ key: keyOf(events[index], index), text });
    }
    return steps;
}

/**
 * A summary as one short spoken sentence: its first sentence, cut at a word
 * within the limit, made speakable (numbers, abbreviations, citations).
 */
export function spokenStep(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
    let short = sentence;
    if (short.length > MAX_SPOKEN_STEP_CHARS) {
        const cut = short.slice(0, MAX_SPOKEN_STEP_CHARS);
        short = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[,;:\s]+$/, "");
    }
    if (!/[.!?]$/.test(short)) short = `${short}.`;
    const speakable = new SpeakableStream();
    speakable.push(short);
    speakable.finish();
    return speakable.text.trim();
}
