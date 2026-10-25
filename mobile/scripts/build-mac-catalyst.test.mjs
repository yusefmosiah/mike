import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { XN_PTTS } from "./build-phonon-android.mjs";
import { PINS } from "./build-mac-catalyst.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Capacitor's pin is the @capacitor/ios version the app depends on", () => {
  const range = JSON.parse(read("../package.json")).dependencies["@capacitor/ios"];
  assert.equal(range.replace(/^\^/, ""), PINS.capacitor.version);
});

test("xn-ptts's pin matches the speech plugin and the Android build", () => {
  assert.match(read("../plugins/speech/Package.swift"), new RegExp(`xn-ptts\\.git", exact: "${PINS.xnPtts.version}"`));
  assert.equal(`v${PINS.xnPtts.version}`, XN_PTTS.tag);
  assert.equal(PINS.xnPtts.commit, XN_PTTS.commit);
});

test("every download is pinned by a SHA-256", () => {
  for (const sha of [
    PINS.capacitor.capacitorZip,
    PINS.capacitor.cordovaZip,
    PINS.capacitor.source,
    PINS.xnPtts.phononCoreZip,
    PINS.xnPtts.source,
  ]) {
    assert.match(sha, /^[0-9a-f]{64}$/);
  }
});
