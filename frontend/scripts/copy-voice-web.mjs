// Copies ONNX Runtime Web's plain WebAssembly build (no JSEP, no WebGPU) from
// node_modules into public/voice-web/ort/, where voice mode's listening worker
// in the browser loads it by URL (src/app/lib/voice/web/vad.worker.ts) to run
// Silero VAD. It is the same onnxruntime-web that @huggingface/transformers
// already installs, so there is no second copy of the package; it is served
// by the app rather than a CDN. Run by `prebuild` and `predev`;
// public/voice-web/ort/ is generated and not committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "voice-web", "ort");

// Where npm put the copy @huggingface/transformers uses: nested under it when
// versions differ, hoisted otherwise.
const source = [
    join(root, "node_modules", "@huggingface", "transformers", "node_modules", "onnxruntime-web"),
    join(root, "node_modules", "onnxruntime-web"),
].find((path) => existsSync(join(path, "package.json")));
if (!source) {
    console.error("onnxruntime-web is not installed (run npm ci)");
    process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const stamp = join(target, ".version");
if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) process.exit(0);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// The module the worker imports, the WebAssembly loader it imports in turn,
// and the WebAssembly itself (MIT; the licence is in their headers and package.json).
for (const file of ["dist/ort.wasm.min.mjs", "dist/ort-wasm-simd-threaded.mjs", "dist/ort-wasm-simd-threaded.wasm"]) {
    copyFileSync(join(source, file), join(target, file.replace(/^dist\//, "")));
}
writeFileSync(stamp, version);
console.log(`onnxruntime-web ${version} copied to public/voice-web/ort`);
