import assert from "node:assert/strict";
import { test } from "node:test";

import { XN_PTTS, ndkHome, rustFlags } from "./build-phonon-android.mjs";

test("xn-ptts is pinned to a release and its commit", () => {
  assert.equal(XN_PTTS.tag, "v0.4.0");
  assert.match(XN_PTTS.commit, /^[0-9a-f]{40}$/);
});

test("the rust flags match xn-ptts's android/build.sh for arm64", () => {
  assert.equal(
    rustFlags(),
    "-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384 -C target-cpu=generic -C target-feature=+dotprod,+fp16",
  );
  assert.equal(rustFlags(""), "-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384 -C target-cpu=generic");
});

test("the NDK is ANDROID_NDK_HOME, else the newest in the SDK", () => {
  assert.equal(ndkHome({ ANDROID_NDK_HOME: "/ndk" }), "/ndk");
  const list = () => ["26.1.10909125", "27.3.13750724", "27.0.12077973", "notes.txt"];
  assert.equal(ndkHome({ ANDROID_HOME: "/sdk" }, list), "/sdk/ndk/27.3.13750724");
  assert.equal(ndkHome({ ANDROID_HOME: "/sdk" }, () => []), null);
  assert.equal(ndkHome({ ANDROID_HOME: "/sdk" }, () => { throw new Error("missing"); }), null);
  assert.equal(ndkHome({}), null);
});
