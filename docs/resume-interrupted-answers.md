# Resuming interrupted answers

Design for answers that stop partway. Status: approved for implementation.

## Evidence (node-a, 10–15 Oct 2026)

7 of 421 assistant answers ended in an error, and 4 more were left empty
(`content` null, no error). None was a provider failure mid-answer (no 429,
5xx, overload, timeout or dropped connection in the logs). They were:

- A deploy restarted the backend mid-answer (4,512 characters shown); the
  turn was resumed on boot and failed with `The answer could not be completed
  (no_model)` from `resumeChatTurn` (`backend/src/modules/chat/chat.turn.ts`),
  via `turnResumers.ts`.
- 3 × `The last message must be the user's input` (`runTurn`,
  `backend/src/lib/llm/pi/runtime.mts`, two checks near the top of `runTurn`):
  the history sent to the model ended with an assistant message. Two came
  about two minutes after a restart.
- 1 × "stopped before writing an answer", the user's retry right after the
  failed resume.
- 1 × an abort during a long document read, cause unclear.
- 1 × a provider 400 before any output (not retryable).

The backend restarted ~25 times on 10 Oct and 4 times on 13 Oct. Restarts
are the dominant cause.

## What the code does today

- Pi Durable retries a failed generation attempt itself
  (`node_modules/@earendil-works/pi-durable/dist/harness/generation.js`:
  `DEFAULT_RETRY_POLICY` 3 retries, 2 s base, for errors pi-ai's
  `isRetryableAssistantError` accepts). A retry is a fresh attempt: it
  regenerates the whole message.
- `runtime.mts` streams text by diffing each assistant message's blocks
  (`emit`, `adopt`); a new `message_start` resets `sent`. So when an attempt
  fails after streaming text and pi retries, the reader keeps the failed
  attempt's text and then receives the retry's text from the start: the
  answer is duplicated.
- A message that stops at the output limit (`stopReason: "length"`) is
  treated as a finished answer: it ends mid-sentence with no error.
- On boot, interrupted turns are resumed (`resumeInterruptedChatTurn`); the
  runtime replays committed entries and skips a message the crash cut off
  (`stopReason === "aborted"`), which pi then regenerates whole.

## Goal

An answer that has started is never started over and never duplicated. It
continues from where it stopped, seamlessly, or ends with the text so far and
a clear error once every attempt has failed.

## Changes, in priority order

### 1. Don't interrupt answers on deploy

On SIGTERM the backend stops starting new background work and waits for
in-flight assistant turns to finish, up to a deadline (90 s), then exits.
HTTP keeps being served during the wait (single instance; there is nowhere
else to send requests). A turn still running at the deadline is left for the
boot-time resume (change 2), which now continues it seamlessly.

Container stop timeouts must exceed the deadline: set `stop_grace_period`
(and the Podman equivalent if Compose's is not honoured) in
`docker-compose.yml`. If `infra/node-a/staging.nix` or the `mike-staging`
deploy script also needs a timeout change, make the repository change and
list it in the report as needing a node-a rebuild; do not touch node-a.

### 2. Restart resume works, and continues instead of regenerating

- Find and fix `no_model`: the resumed turn's conversation has no model bound
  after a restart. Add a regression test that resumes a turn in a fresh
  harness.
- A message the restart cut off is continued (change 4's continuation), not
  regenerated: its partial text is in storage (progress is committed every
  100 ms) and was already shown to the reader before the restart.

### 3. Fix "The last message must be the user's input"

Trace how a turn's history can end with an assistant message (after a
restart, a failed resume, or a retry of a failed answer: the empty or
errored assistant row may be sent as history). Fix the cause, not the check;
add a regression test reproducing the sequence.

### 4. Continue, don't retry, once text has been shown

Mike's runtime owns retries instead of pi:

- Turn pi's automatic retry off for chat generations (`settings.retry`),
  so every failed attempt reaches `runTurn`.
- In `runTurn`, after `settle()`, in the style of the existing language-drift
  resubmission (`LANGUAGE_DRIFT_NOTE`, a request id `turn:<key>:…` so a
  resumed turn never submits twice):
  - **Failed, nothing shown yet** and retryable (pi-ai's
    `isRetryableAssistantError`): submit again after backoff (2 s, 4 s, 8 s;
    honour a provider's retry-after when known). Same behaviour as pi's
    retry today.
  - **Failed after text was shown** and retryable, or **stopped at the
    output limit** (`stopReason: "length"`): submit a hidden continuation
    note. It carries the text written so far in this message (the last
    ~1,500 characters is enough; verify whether pi-ai drops an errored
    assistant message from the context and, if it keeps it, say so in the
    note rather than repeating it), and asks the model to continue from the
    next character, without repeating anything or mentioning the
    interruption.
  - **Not retryable** (quota, billing, auth, a 400): stop, as today.
  - **Context overflow**: keep pi's compaction path.
  - At most 3 attempts per turn in total.
- Seamless joining: the continuation's text streams into the same answer
  segment (do not end the visible segment between the cut-off text and the
  continuation, so an inline `<cite>` tag cut in half is completed by the
  continuation; see `InlineCitationStream` in `citations.inline.ts`). Hold
  back the continuation's first ~200 characters and trim any overlap with the
  end of the shown text (longest suffix of the shown text equal to a prefix
  of the continuation, compared with whitespace collapsed, at least 12
  characters) before showing anything.
- While waiting to retry or continue, send a transient status event the
  client already understands if one exists; otherwise add none (no frontend
  change in this work).
- Every attempt is logged with `safeError` (attempt number, reason,
  characters shown so far) so the next log review can count them.

## Acceptance tests

- A provider error after 300 characters: the reader sees the 300 characters
  once, then the continuation; no duplicate text; stored answer is one
  continuous text.
- The continuation repeating the last sentence: the overlap is trimmed.
- An error before any text: retried; the reader sees one answer.
- `stopReason: "length"`: continued; the stored answer is whole.
- A non-retryable error after text: the text so far plus the error, no
  continuation.
- Three failed attempts: the text so far plus the error.
- A `<cite>` tag split by an interruption produces one marker.
- Resume after a restart in a fresh harness: no `no_model`; the cut-off
  message continues rather than restarts.
- The sequence that produced "The last message must be the user's input"
  succeeds.
- SIGTERM with a turn in flight: the process waits for it (up to the
  deadline) before exiting.

## Not changing

- The frontend and the Word add-in.
- Inline citations' behaviour (only their segment boundary, as above).
- Compaction.
