// Copies the phonon-tts package (read-aloud in the browser, see
// src/app/lib/voice/browserModels.phonon.ts) from node_modules into
// public/phonon-tts/, which the app serves as static files and loads at
// runtime. The page imports it by URL instead of through the bundler:
// Turbopack never finished compiling the package (its worker and four
// WebAssembly files, referenced with `new URL(..., import.meta.url)`; the
// build ran past 15 minutes with no CPU use, where the same build without the
// import takes 15 seconds), and the package needs no bundler. Run by
// `prebuild` and `predev`; public/phonon-tts/ is generated and not committed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "phonon-tts");
const target = join(root, "public", "phonon-tts");

if (!existsSync(join(source, "package.json"))) {
    console.error("phonon-tts is not installed (run npm ci)");
    process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const stamp = join(target, ".version");
if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) process.exit(0);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, {
    recursive: true,
    // Only what the browser loads: scripts, WebAssembly and the licences.
    filter: (path) => !/(\.d\.ts|README\.md|package\.json)$/.test(path),
});
writeFileSync(stamp, version);
console.log(`phonon-tts ${version} copied to public/phonon-tts`);
