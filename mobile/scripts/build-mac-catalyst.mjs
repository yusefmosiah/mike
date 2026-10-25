// Prepares the two binary dependencies that ship without a Mac Catalyst
// slice, so the iOS app builds for the Mac (docs/mac-app.md):
//
//   - capacitor-swift-pm: Capacitor.xcframework and Cordova.xcframework have
//     iPhone and simulator slices only. The Catalyst slice is built here
//     from Capacitor's source at the same release tag.
//   - xn-ptts (Phonon, plugins/speech): PhononCore.xcframework has iPhone,
//     simulator and macOS slices, and a macOS library cannot be linked into
//     a Catalyst app. The Catalyst slice (aarch64-apple-ios-macabi) is built
//     here from xn-ptts's source at the pinned commit.
//
// Each output xcframework holds the release's own iOS slices, byte for byte
// (every download is checked against the SHA-256 Swift Package Manager pins),
// plus the new Catalyst slice. They are written as local Swift packages under
// ios/App/MacCatalyst/, which `npm run ios:configure` adds to the Xcode
// project; a local package overrides the remote package of the same name for
// the whole build, so the iOS build links exactly the binaries it linked
// before and the Mac build finds its slice.
//
// Needs Xcode, network access and rustup (the pinned
// toolchain below is installed for this build only; the default toolchain is
// not changed). A no-op when the outputs match the pins. Apple silicon only,
// like Phonon itself and the Electron app before it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PINS = {
  capacitor: {
    // Must equal @capacitor/ios's version, which `cap sync` pins in CapApp-SPM.
    version: "8.5.3",
    capacitorZip: "9316f568444411d362dcb4d1946e7572d4aef5d690c122ff6f1cb8a44a920c9f",
    cordovaZip: "bdcd8eab2d62a077efd76c3c8b9629e65ae7043c1462289a1e55de9be19bbf1f",
    source: "bb627e67f8948d5f6b74dd8e2cc20c7814544933a77e055dd18df066b7228ae4",
  },
  xnPtts: {
    // Must equal the plugin's pin (plugins/speech/Package.swift) and
    // scripts/build-phonon-android.mjs.
    version: "0.4.0",
    commit: "f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa",
    phononCoreZip: "a10382948448087bc9f63231de3c2970d606979fd69bef7acb95d2dfa3a41cef",
    source: "fc99775ae12cbd49e3aa7de279b4bff342dd6ac2776feb415ed70db53068fd27",
  },
  // The rustc that built xn-ptts 0.4.0's released slices (its objects name
  // it), so the Catalyst slice matches them.
  rustToolchain: "1.99.1",
};

const mobile = fileURLToPath(new URL("../", import.meta.url));
export const OUTPUT = `${mobile}ios/App/MacCatalyst`;
const cache = `${mobile}.cache/mac-catalyst`;

// xcodebuild reads the environment as build settings, and a dev shell's LD,
// CC or SDKROOT breaks the build (README.md), so tools run in a clean one.
const home = process.env.HOME;
const cleanEnv = {
  HOME: home,
  PATH: `${home}/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, { env: cleanEnv, stdio: ["ignore", "inherit", "inherit"], ...options });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Downloads `url` to `path` once; refuses a file whose SHA-256 differs. */
async function download(url, path, expected) {
  if (existsSync(path) && sha256(path) === expected) return path;
  let bytes;
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed: ${url}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual}, expected ${expected}: refusing it`);
  writeFileSync(path, bytes);
  return path;
}

function unpack(archive, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  if (archive.endsWith(".zip")) run("/usr/bin/ditto", ["-x", "-k", archive, into]);
  else run("/usr/bin/tar", ["-xzf", archive, "-C", into, "--strip-components", "1"]);
  return into;
}

function checkPins() {
  const capacitor = JSON.parse(readFileSync(`${mobile}node_modules/@capacitor/ios/package.json`, "utf8")).version;
  if (capacitor !== PINS.capacitor.version) {
    throw new Error(
      `@capacitor/ios is ${capacitor} but scripts/build-mac-catalyst.mjs pins ${PINS.capacitor.version}: update PINS.capacitor (version and checksums)`,
    );
  }
  const plugin = readFileSync(`${mobile}plugins/speech/Package.swift`, "utf8");
  if (!plugin.includes(`xn-ptts.git", exact: "${PINS.xnPtts.version}"`)) {
    throw new Error(`plugins/speech/Package.swift does not pin xn-ptts ${PINS.xnPtts.version}: update PINS.xnPtts`);
  }
}

async function capacitor() {
  const { version } = PINS.capacitor;
  const work = `${cache}/capacitor-${version}`;
  mkdirSync(work, { recursive: true });
  const release = `https://github.com/ionic-team/capacitor-swift-pm/releases/download/${version}`;
  const official = {
    Capacitor: unpack(await download(`${release}/Capacitor.xcframework.zip`, `${work}/Capacitor.xcframework.zip`, PINS.capacitor.capacitorZip), `${work}/official-Capacitor`),
    Cordova: unpack(await download(`${release}/Cordova.xcframework.zip`, `${work}/Cordova.xcframework.zip`, PINS.capacitor.cordovaZip), `${work}/official-Cordova`),
  };
  const source = unpack(
    await download(`https://github.com/ionic-team/capacitor/archive/refs/tags/${version}.tar.gz`, `${work}/source.tar.gz`, PINS.capacitor.source),
    `${work}/source`,
  );
  // The same archive step as capacitor-swift-pm's build-cap, for Catalyst.
  const archives = `${work}/archives`;
  rmSync(archives, { recursive: true, force: true });
  for (const scheme of ["Cordova", "Capacitor"]) {
    run(
      "xcodebuild",
      [
        "archive", "-quiet",
        "-workspace", "Capacitor.xcworkspace", "-scheme", scheme,
        "-destination", "generic/platform=macOS,variant=Mac Catalyst",
        "-archivePath", `${archives}/${scheme}`, "-derivedDataPath", `${work}/derived`,
        "SKIP_INSTALL=NO", "SUPPORTS_MACCATALYST=YES", "BUILD_LIBRARY_FOR_DISTRIBUTION=YES",
        "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym", "SWIFT_SERIALIZE_DEBUGGING_OPTIONS=NO",
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: `${source}/ios/Capacitor` },
    );
  }
  const out = `${OUTPUT}/capacitor-swift-pm`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of ["Capacitor", "Cordova"]) {
    const xcf = `${official[name]}/${name}.xcframework`;
    const archive = `${archives}/${name}.xcarchive`;
    run("xcodebuild", [
      "-create-xcframework",
      "-framework", `${xcf}/ios-arm64/${name}.framework`, "-debug-symbols", `${xcf}/ios-arm64/dSYMs/${name}.framework.dSYM`,
      "-framework", `${xcf}/ios-arm64_x86_64-simulator/${name}.framework`, "-debug-symbols", `${xcf}/ios-arm64_x86_64-simulator/dSYMs/${name}.framework.dSYM`,
      "-framework", `${archive}/Products/Library/Frameworks/${name}.framework`, "-debug-symbols", `${archive}/dSYMs/${name}.framework.dSYM`,
      "-output", `${out}/${name}.xcframework`,
    ]);
  }
  writeFileSync(
    `${out}/Package.swift`,
    `// swift-tools-version:5.3
// Written by mobile/scripts/build-mac-catalyst.mjs: capacitor-swift-pm ${version}
// with a Mac Catalyst slice. The iOS slices are the release's own.
import PackageDescription

let package = Package(
    name: "capacitor-swift-pm",
    products: [
        .library(name: "Capacitor", targets: ["Capacitor"]),
        .library(name: "Cordova", targets: ["Cordova"])
    ],
    targets: [
        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),
        .binaryTarget(name: "Cordova", path: "Cordova.xcframework")
    ]
)
`,
  );
}

async function xnPtts() {
  const { version, commit } = PINS.xnPtts;
  const work = `${cache}/xn-ptts-${version}`;
  mkdirSync(work, { recursive: true });
  const official = unpack(
    await download(
      `https://github.com/gradium-ai/xn-ptts/releases/download/v${version}/PhononCore.xcframework.zip`,
      `${work}/PhononCore.xcframework.zip`,
      PINS.xnPtts.phononCoreZip,
    ),
    `${work}/official`,
  );
  const source = unpack(
    await download(`https://github.com/gradium-ai/xn-ptts/archive/${commit}.tar.gz`, `${work}/source.tar.gz`, PINS.xnPtts.source),
    `${work}/source`,
  );
  const target = "aarch64-apple-ios-macabi";
  const toolchain = PINS.rustToolchain;
  run("rustup", ["toolchain", "install", toolchain, "--profile", "minimal", "--target", target]);
  // The repository's .cargo/config.toml builds for the host CPU; the app
  // runs on any Apple-silicon Mac, so the floor is the M1.
  run("cargo", [`+${toolchain}`, "build", "--release", "-p", "ptts-ffi", "--target", target], {
    cwd: source,
    env: {
      ...cleanEnv,
      CARGO_TARGET_AARCH64_APPLE_IOS_MACABI_RUSTFLAGS: "-C target-cpu=apple-m1",
      IPHONEOS_DEPLOYMENT_TARGET: "18.0",
    },
  });
  const out = `${OUTPUT}/xn-ptts`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const xcf = `${official}/PhononCore.xcframework`;
  const library = (slice) => ["-library", `${xcf}/${slice}/libptts_ffi.a`, "-headers", `${xcf}/${slice}/Headers`];
  run("xcodebuild", [
    "-create-xcframework",
    ...library("ios-arm64"),
    ...library("ios-arm64-simulator"),
    ...library("macos-arm64"),
    "-library", `${source}/target/${target}/release/libptts_ffi.a`, "-headers", `${xcf}/ios-arm64/Headers`,
    "-output", `${out}/PhononCore.xcframework`,
  ]);
  cpSync(`${source}/ios/PhononTTS/Sources/PhononTTS`, `${out}/Sources/PhononTTS`, { recursive: true });
  for (const license of ["LICENSE-APACHE", "LICENSE-MIT"]) cpSync(`${source}/${license}`, `${out}/${license}`);
  // The release's own manifest (Package.swift at the tag), with the core by path.
  writeFileSync(
    `${out}/Package.swift`,
    `// swift-tools-version:6.0
// Written by mobile/scripts/build-mac-catalyst.mjs: xn-ptts ${version} (${commit})
// with a Mac Catalyst slice in PhononCore. The other slices are the release's own.
import PackageDescription

let package = Package(
    name: "ptts",
    platforms: [.iOS(.v18), .macOS(.v15), .macCatalyst(.v18)],
    products: [
        .library(name: "ptts", targets: ["PhononTTS"]),
    ],
    targets: [
        .binaryTarget(name: "PhononCore", path: "PhononCore.xcframework"),
        .target(
            name: "PhononTTS",
            dependencies: ["PhononCore"],
            path: "Sources/PhononTTS",
            linkerSettings: [
                .linkedFramework("CoreML"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("Accelerate"),
                .linkedFramework("AVFoundation"),
            ]
        ),
    ]
)
`,
  );
}

async function main() {
  const stamp = `${OUTPUT}/pins.json`;
  const pins = `${JSON.stringify(PINS, null, 2)}\n`;
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === pins) {
    console.log("Mac Catalyst dependencies are up to date");
    return;
  }
  if (!existsSync(`${mobile}ios/App/App.xcodeproj`)) throw new Error("No iOS project: run `npm run ios:add` first");
  checkPins();
  mkdirSync(cache, { recursive: true });
  rmSync(stamp, { force: true });
  await capacitor();
  await xnPtts();
  writeFileSync(stamp, pins);
  console.log(`Mac Catalyst dependencies written to ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
