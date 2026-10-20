// node --test scripts/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchSpeechModel, ModelHashMismatch } from "./fetch-speech-model.mjs";

const bytes = (text) => Buffer.from(text);
const entry = (path, text, dest) => ({
  path,
  ...(dest ? { dest } : {}),
  size: bytes(text).length,
  sha256: createHash("sha256").update(text).digest("hex"),
});
const served = { "a.bin": "alpha", "dir/b.bin": "beta" };
const manifest = {
  repository: "owner/model",
  revision: "abc123",
  files: [entry("a.bin", "alpha"), entry("dir/b.bin", "beta", "dir/renamed.bin")],
};
const respond = (overrides = {}) => async (url) => {
  const path = url.split("/resolve/abc123/")[1];
  requested.push(url);
  return new Response(overrides[path] ?? served[path]);
};
let requested = [];

test("downloads from the pinned revision, verifies, and places files at their destination", async () => {
  requested = [];
  const dir = mkdtempSync(join(tmpdir(), "model-"));
  assert.equal(await fetchSpeechModel({ manifest, dir, fetchFile: respond(), log: () => {} }), 2);
  assert.equal(readFileSync(join(dir, "a.bin"), "utf8"), "alpha");
  assert.equal(readFileSync(join(dir, "dir/renamed.bin"), "utf8"), "beta");
  assert.deepEqual(requested, [
    "https://huggingface.co/owner/model/resolve/abc123/a.bin",
    "https://huggingface.co/owner/model/resolve/abc123/dir/b.bin",
  ]);
});

test("a second run downloads nothing, and a changed file is fetched again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-"));
  await fetchSpeechModel({ manifest, dir, fetchFile: respond(), log: () => {} });
  requested = [];
  assert.equal(await fetchSpeechModel({ manifest, dir, fetchFile: respond(), log: () => {} }), 0);
  assert.deepEqual(requested, []);
  writeFileSync(join(dir, "a.bin"), "tampered");
  assert.equal(await fetchSpeechModel({ manifest, dir, fetchFile: respond(), log: () => {} }), 1);
  assert.equal(readFileSync(join(dir, "a.bin"), "utf8"), "alpha");
});

test("refuses a download whose hash differs and keeps nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-"));
  await assert.rejects(
    fetchSpeechModel({ manifest, dir, fetchFile: respond({ "a.bin": "ALPHA" }), log: () => {} }),
    ModelHashMismatch,
  );
  assert.equal(existsSync(join(dir, "a.bin")), false);
  assert.equal(existsSync(join(dir, "a.bin.part")), false);
});

test("a failed request is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-"));
  await assert.rejects(
    fetchSpeechModel({ manifest, dir, fetchFile: async () => new Response("no", { status: 404 }), log: () => {} }),
    /HTTP 404/,
  );
});
