// Builds Phonon's C library for Android (libptts_ffi.so, arm64-v8a) from
// xn-ptts at the pinned release and puts it where the speech plugin's Android
// module packages it (plugins/speech/android/src/main/jniLibs, gitignored).
// xn-ptts publishes no Android library for the CPU (its QNN AAR is a source
// preview), so this follows its android/build.sh for one ABI. Without the
// library the app builds and reports Phonon unavailable on Android.
//
// Needs git, Rust (rustup), cargo-ndk (`cargo install cargo-ndk`) and the
// Android NDK (ANDROID_NDK_HOME, or the newest under $ANDROID_HOME/ndk).
// A no-op when the library from this commit is already in place.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const XN_PTTS = {
  repository: "https://github.com/gradium-ai/xn-ptts.git",
  tag: "v0.4.0",
  commit: "f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa",
};

/**
 * build.sh's flags for arm64: generic CPU with dotprod and fp16 (ARMv8.2,
 * every phone since about 2019; xn picks kernels at compile time, so a phone
 * without them would crash), stripped, 16 KB pages.
 */
export function rustFlags(features = "+dotprod,+fp16") {
  const common = "-C strip=symbols -C link-arg=-Wl,-z,max-page-size=16384";
  return `${common} -C target-cpu=generic${features ? ` -C target-feature=${features}` : ""}`;
}

/** ANDROID_NDK_HOME, or the newest NDK in the SDK. */
export function ndkHome(env, list = (dir) => readdirSync(dir)) {
  if (env.ANDROID_NDK_HOME) return env.ANDROID_NDK_HOME;
  if (!env.ANDROID_HOME) return null;
  const root = `${env.ANDROID_HOME}/ndk`;
  let versions;
  try {
    versions = list(root);
  } catch {
    return null;
  }
  const newest = versions
    .filter((name) => /^\d+(\.\d+)*$/.test(name))
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    })[0];
  return newest ? `${root}/${newest}` : null;
}

function main() {
  const mobile = fileURLToPath(new URL("../", import.meta.url));
  const output = `${mobile}plugins/speech/android/src/main/jniLibs/arm64-v8a`;
  const library = `${output}/libptts_ffi.so`;
  const stamp = `${output}/libptts_ffi.commit`;
  if (existsSync(library) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === XN_PTTS.commit) {
    console.log(`libptts_ffi.so is up to date (xn-ptts ${XN_PTTS.tag})`);
    return;
  }
  const ndk = ndkHome(process.env);
  if (!ndk) throw new Error("No Android NDK: set ANDROID_NDK_HOME or install one under $ANDROID_HOME/ndk");

  const source = `${mobile}.cache/xn-ptts-${XN_PTTS.tag}`;
  if (!existsSync(source)) {
    mkdirSync(`${mobile}.cache`, { recursive: true });
    execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", XN_PTTS.tag, XN_PTTS.repository, source], { stdio: "inherit" });
  }
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== XN_PTTS.commit) {
    throw new Error(`xn-ptts ${XN_PTTS.tag} is ${head}, expected ${XN_PTTS.commit}: refusing to build`);
  }

  execFileSync("rustup", ["target", "add", "aarch64-linux-android"], { stdio: "inherit" });
  const env = { ...process.env, ANDROID_NDK_HOME: ndk, CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS: rustFlags() };
  // Either would take precedence over the flags above and drop them.
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const built = `${source}/android/jniLibs`;
  rmSync(built, { recursive: true, force: true });
  execFileSync("cargo", ["ndk", "-t", "arm64-v8a", "-o", built, "build", "--release", "-p", "ptts-ffi"], { cwd: source, env, stdio: "inherit" });

  mkdirSync(output, { recursive: true });
  copyFileSync(`${built}/arm64-v8a/libptts_ffi.so`, library);
  writeFileSync(stamp, `${XN_PTTS.commit}\n`);
  console.log(`libptts_ffi.so built from xn-ptts ${XN_PTTS.tag} into ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
