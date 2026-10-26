import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import * as webStreams from "node:stream/web";

// Vitest's jsdom environment always overrides `globalThis.Blob` with jsdom's
// own Blob implementation, which never implemented `.text()`/`.arrayBuffer()`/
// `.stream()` (it only has `slice`, `size`, `type`). On Node 24 (unlike
// Node 22), the built-in `Response.prototype.blob()` resolves its `Blob`
// constructor dynamically from `globalThis` at call time, so blobs returned
// from a real `Response` end up jsdom-shaped and missing those methods.
// Restoring the real Node `Blob` here (independent of the global, via
// `node:buffer`) keeps `response.blob()` usable the same way on every
// supported Node version. See #361.
globalThis.Blob = NodeBlob as unknown as typeof Blob;

// findBy* and waitFor give up after 1 s by default. A heavy component's first
// render (a lazy import, the React Compiler transform) can take longer than
// that on a busy CI runner, which failed tests that were not broken. The
// per-test limit (testTimeout in vitest.config.mts) still catches a real hang.
configure({ asyncUtilTimeout: 5000 });

// Most test files run in their own VM context (the "unit" project in
// vitest.config.mts), whose jsdom global lacks the WHATWG streams the
// browser and Node both have. Supply Node's where jsdom has none.
for (const name of [
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextEncoderStream",
    "TextDecoderStream",
    "ByteLengthQueuingStrategy",
    "CountQueuingStrategy",
] as const) {
    if (!(name in globalThis)) {
        Object.assign(globalThis, { [name]: webStreams[name] });
    }
}
