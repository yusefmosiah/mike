// Downloads Fluid Speech Mini (Core ML) for the iPhone app's dictation
// (plugins/speech/README.md) from Hugging Face at the revision pinned in
// speech-model.manifest.json, checks every file's SHA-256 against that
// manifest, and places the files where the speech plugin's Swift package
// copies them into the app. The files are never committed (.gitignore).
//
// Re-running is a no-op while the files on disk match; a file that differs is
// fetched again. A download whose hash does not match the manifest is
// discarded and the script exits with an error: nothing unverified is kept.
// MIKE_SKIP_SPEECH_MODEL=1 skips the download (CI, or a build that does not
// need the model: the app then reports the model unavailable and dictation
// uses Apple's recognizer).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(here, "speech-model.manifest.json");
export const MODEL_DIR = join(here, "../plugins/speech/ios/Sources/MikeSpeechPlugin/FluidSpeechMini");

export class ModelHashMismatch extends Error {}

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function matches(path, entry) {
  try {
    if (!existsSync(path) || statSync(path).size !== entry.size) return false;
    return (await sha256OfFile(path)) === entry.sha256;
  } catch {
    return false;
  }
}

async function download(response, target) {
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

/**
 * Makes `dir` hold exactly the manifest's files. `fetchFile` is injectable
 * for tests. Returns the number of files downloaded.
 */
export async function fetchSpeechModel({
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  dir = MODEL_DIR,
  fetchFile = fetch,
  log = console.log,
} = {}) {
  let downloaded = 0;
  for (const entry of manifest.files) {
    const target = join(dir, entry.dest ?? entry.path);
    if (await matches(target, entry)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${entry.path}`;
    log(`fetching ${entry.path} (${(entry.size / 1e6).toFixed(1)} MB)`);
    try {
      await download(await fetchFile(url), partial);
      const actual = await sha256OfFile(partial);
      if (actual !== entry.sha256) {
        throw new ModelHashMismatch(`${entry.path}: expected sha256 ${entry.sha256}, got ${actual}`);
      }
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
    downloaded += 1;
  }
  return downloaded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.MIKE_SKIP_SPEECH_MODEL === "1") {
    console.log("speech model skipped (MIKE_SKIP_SPEECH_MODEL=1)");
  } else {
    fetchSpeechModel()
      .then((count) => console.log(count ? `speech model ready (${count} files fetched)` : "speech model up to date"))
      .catch((error) => {
        console.error(error instanceof ModelHashMismatch ? `refusing a file that does not match the manifest: ${error.message}` : error.message);
        process.exit(1);
      });
  }
}
