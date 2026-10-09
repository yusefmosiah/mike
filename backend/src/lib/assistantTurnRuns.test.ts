import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  FINISHED_RUN_RETENTION_MS,
  MAX_RUN_LIFETIME_MS,
  STOPPED_RUN_GRACE_MS,
  STREAM_RUNS_INCARNATION,
  attachAssistantTurnSse,
  getActiveAssistantTurn,
  getAssistantTurnRun,
  requestedIncarnation,
  resetAssistantTurnRunsForTests,
  startAssistantTurnRun,
} from "./assistantTurnRuns";

/** An Express response reduced to what SSE streaming touches. */
function fakeResponse() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  // The incarnation announcement every attach opens with, kept apart so the
  // frame assertions below read as the run's own frames.
  const announced: string[] = [];
  const res = {
    headers: {} as Record<string, string>,
    writableEnded: false,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    flushHeaders: vi.fn(),
    write(chunk: string) {
      (chunk.includes('"type":"stream_incarnation"') ? announced : chunks).push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
    },
    on: emitter.on.bind(emitter),
    close() {
      emitter.emit("close");
    },
    chunks,
    announced,
  };
  return res;
}

const start = (id = "turn-1", chatId = "chat-1") =>
  startAssistantTurnRun({ id, chatId, userId: "u1", assistantMessageId: id })!;

afterEach(() => {
  resetAssistantTurnRunsForTests();
  vi.useRealTimers();
});

describe("assistant turn runs", () => {
  it("survives the requesting response closing and only stops on stop()", () => {
    const run = start();
    const res = fakeResponse();
    const stream = attachAssistantTurnSse(res as unknown as Response, run);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.flushHeaders).toHaveBeenCalled();

    stream.write('data: {"type":"content_delta","text":"a"}\n\n');
    expect(res.chunks).toEqual(['id: 1\ndata: {"type":"content_delta","text":"a"}\n\n']);

    // The refresh: the socket goes away. The generation must not.
    res.close();
    expect(stream.signal.aborted).toBe(false);
    expect(stream.write('data: {"type":"content_delta","text":"b"}\n\n')).toBe(true);
    expect(res.chunks).toHaveLength(1);
    expect(run.seq).toBe(2);
    expect(getActiveAssistantTurn("chat-1")).toEqual({
      id: "turn-1",
      seq: 2,
      assistant_message_id: "turn-1",
    });

    run.stop();
    expect(stream.signal.aborted).toBe(true);
    expect(run.stopped).toBe(true);
  });

  it("replays buffered frames from a sequence number, then tails, then ends", () => {
    const run = start();
    run.write("data: 1\n\n");
    run.write("data: 2\n\n");
    run.write("data: 3\n\n");

    const late = fakeResponse();
    attachAssistantTurnSse(late as unknown as Response, run, 2);
    expect(late.chunks).toEqual(["id: 2\ndata: 2\n\n", "id: 3\ndata: 3\n\n"]);

    run.write("data: 4\n\n");
    expect(late.chunks).toHaveLength(3);
    expect(late.writableEnded).toBe(false);

    run.finish();
    expect(late.writableEnded).toBe(true);
    expect(run.write("data: late\n\n")).toBe(false);
    expect(getActiveAssistantTurn("chat-1")).toBeNull();

    // Within the retention window a reconnect still gets the tail and an end.
    const after = fakeResponse();
    attachAssistantTurnSse(after as unknown as Response, run, 4);
    expect(after.chunks).toEqual(["id: 4\ndata: 4\n\n"]);
    expect(after.writableEnded).toBe(true);
  });

  it("refuses a second concurrent run for the same chat, and frees the slot on finish", () => {
    const first = start("turn-1");
    expect(startAssistantTurnRun({ id: "turn-2", chatId: "chat-1", userId: "u1", assistantMessageId: "turn-2" })).toBeNull();
    expect(start("other", "chat-2").chatId).toBe("chat-2");
    first.finish();
    expect(start("turn-2")).toBeTruthy();
  });

  it("forgets a finished run after the retention window and stops a run that outlives its lifetime", () => {
    vi.useFakeTimers();
    const run = start();
    run.finish();
    expect(getAssistantTurnRun("turn-1")).toBe(run);
    vi.advanceTimersByTime(FINISHED_RUN_RETENTION_MS + 1);
    expect(getAssistantTurnRun("turn-1")).toBeUndefined();

    const hung = start("turn-hung");
    vi.advanceTimersByTime(MAX_RUN_LIFETIME_MS + 1);
    expect(hung.signal.aborted).toBe(true);
  });

  it("ends a wedged stopped turn with cancelled and done frames", () => {
    vi.useFakeTimers();
    const run = start("turn-hung");
    const reader = fakeResponse();
    attachAssistantTurnSse(reader as unknown as Response, run);

    run.stop();
    vi.advanceTimersByTime(STOPPED_RUN_GRACE_MS + 1);

    expect(reader.chunks).toEqual([
      'id: 1\ndata: {"type":"cancelled"}\n\n',
      "id: 2\ndata: [DONE]\n\n",
    ]);
    expect(reader.writableEnded).toBe(true);
  });

  it("drops a subscriber whose response throws and keeps serving the others", () => {
    const run = start();
    const healthy = fakeResponse();
    attachAssistantTurnSse(healthy as unknown as Response, run);
    const broken = { write: () => { throw new Error("EPIPE"); }, end: vi.fn() };
    run.subscribe(1, broken);
    run.write("data: x\n\n");
    expect(healthy.chunks).toHaveLength(1);
    run.finish();
    expect(broken.end).not.toHaveBeenCalled();
    expect(healthy.writableEnded).toBe(true);
  });

  it("announces the incarnation to every reader before any frame", () => {
    const run = start();
    const res = fakeResponse();
    const stream = attachAssistantTurnSse(res as unknown as Response, run);
    stream.write('data: {"type":"content_delta","text":"a"}\n\n');
    expect(res.announced).toEqual([
      `data: {"type":"stream_incarnation","incarnation":"${STREAM_RUNS_INCARNATION}"}\n\n`,
    ]);
    // Unnumbered, so a reader's sequence cursor is untouched by it.
    expect(res.announced[0]).not.toMatch(/^id:/);
  });

  it("resumes within the same incarnation from the requested frame", () => {
    const run = start();
    const stream = attachAssistantTurnSse(fakeResponse() as unknown as Response, run);
    for (const text of ["a", "b", "c"]) {
      stream.write(`data: {"type":"content_delta","text":"${text}"}\n\n`);
    }
    const again = fakeResponse();
    attachAssistantTurnSse(again as unknown as Response, run, 3, STREAM_RUNS_INCARNATION);
    expect(again.chunks).toEqual(['id: 3\ndata: {"type":"content_delta","text":"c"}\n\n']);
  });

  it("restarts a reader from frame 1 when its frames came from an earlier incarnation", () => {
    // A turn resumed after a restart: same id, numbering from 1 again.
    const run = start();
    const stream = attachAssistantTurnSse(fakeResponse() as unknown as Response, run);
    for (const text of ["a", "b"]) {
      stream.write(`data: {"type":"content_delta","text":"${text}"}\n\n`);
    }
    const reader = fakeResponse();
    attachAssistantTurnSse(
      reader as unknown as Response,
      run,
      40,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(reader.chunks).toEqual([
      'data: {"type":"turn_restarted"}\n\n',
      'id: 1\ndata: {"type":"content_delta","text":"a"}\n\n',
      'id: 2\ndata: {"type":"content_delta","text":"b"}\n\n',
    ]);
  });

  it("does not restart a reader that has seen no frames yet", () => {
    const run = start();
    const reader = fakeResponse();
    attachAssistantTurnSse(reader as unknown as Response, run, 1, "00000000-0000-4000-8000-000000000000");
    expect(reader.chunks).toEqual([]);
  });

  it("accepts only uuid-shaped incarnation parameters", () => {
    expect(requestedIncarnation(STREAM_RUNS_INCARNATION)).toBe(STREAM_RUNS_INCARNATION);
    expect(requestedIncarnation(undefined)).toBeNull();
    expect(requestedIncarnation(["a"])).toBeNull();
    expect(requestedIncarnation("not-an-id")).toBeNull();
  });
});
