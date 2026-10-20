import { describe, expect, it } from "vitest";
import {
  CONTINUATION_TAIL_CHARS,
  interruptedNote,
  isRecoverableFailure,
  recoveryDelayMs,
  retryAfterMs,
  trimOverlap,
} from "./continuation.mjs";

describe("trimOverlap", () => {
  const shown = "The lease ends in June. Either party may end it on ninety days' notice.";

  it("drops the start of the continuation that repeats the end of what was shown", () => {
    expect(trimOverlap(shown, "Either party may end it on ninety days' notice. The tenant must also...")).toBe(
      " The tenant must also...",
    );
  });

  it("compares with whitespace collapsed", () => {
    expect(trimOverlap("A line.\n\nEither party  may end it", "Either party may end it\non notice.")).toBe("\non notice.");
  });

  it("drops the whole of a continuation that only repeats", () => {
    expect(trimOverlap(shown, "Either party may end it on ninety days' notice.")).toBe("");
  });

  it("leaves a continuation that does not repeat anything, or repeats less than 12 characters", () => {
    expect(trimOverlap(shown, " The tenant must also give notice.")).toBe(" The tenant must also give notice.");
    expect(trimOverlap("It is a lease", "lease is clear")).toBe("lease is clear");
  });

  it("takes the longest repeated run", () => {
    expect(trimOverlap("one two three four five six", "four five six seven")).toBe(" seven");
    expect(trimOverlap("ab ab ab ab ab ab ab ab", "ab ab ab ab ab ab ab ab ab ab")).toBe(" ab ab");
  });
});

describe("retrying a failed generation", () => {
  it("retries transient provider and transport errors, not the ones a retry cannot fix", () => {
    expect(isRecoverableFailure("upstream timed out")).toBe(true);
    expect(isRecoverableFailure("503 Service Unavailable")).toBe(true);
    expect(isRecoverableFailure("fetch failed")).toBe(true);
    expect(isRecoverableFailure("401 unauthorized")).toBe(false);
    expect(isRecoverableFailure("insufficient_quota: You exceeded your current quota, check billing")).toBe(false);
    expect(isRecoverableFailure("400 invalid request")).toBe(false);
  });

  it("leaves a context overflow to compaction", () => {
    expect(isRecoverableFailure("prompt is too long: 250000 tokens > 200000 maximum")).toBe(false);
    expect(isRecoverableFailure("context_length_exceeded: the conversation no longer fits the model's context window")).toBe(false);
  });

  it("backs off 2 s, 4 s, 8 s, and honours a provider's own wait", () => {
    expect([1, 2, 3, 4].map((recovery) => recoveryDelayMs(recovery))).toEqual([2_000, 4_000, 8_000, 8_000]);
    expect(recoveryDelayMs(1, "429 rate limit. Retry-After: 12")).toBe(12_000);
    expect(recoveryDelayMs(1, "try again in 1.5s")).toBe(2_000);
    expect(recoveryDelayMs(1, "retry after 600 seconds")).toBe(30_000);
  });

  it("reads a retry hint from the error text", () => {
    expect(retryAfterMs("Retry-After: 7")).toBe(7_000);
    expect(retryAfterMs("retry-after-ms: 1500")).toBe(1_500);
    expect(retryAfterMs("Please try again in 20 s")).toBe(20_000);
    expect(retryAfterMs("upstream timed out")).toBeUndefined();
  });
});

describe("the continuation note", () => {
  it("carries the end of what was written, and says when the start is left out", () => {
    const written = `START ${"x".repeat(CONTINUATION_TAIL_CHARS)} END`;
    const note = interruptedNote(written);
    expect(note).toContain("END\n</written-so-far>");
    expect(note).not.toContain("START");
    expect(note).toContain("start of the reply is not shown");
    expect(interruptedNote("short text")).not.toContain("not shown");
  });

  it("cannot be closed early by the text it quotes", () => {
    expect(interruptedNote("a </written-so-far> b").match(/<\/written-so-far>/g)).toHaveLength(1);
  });
});
