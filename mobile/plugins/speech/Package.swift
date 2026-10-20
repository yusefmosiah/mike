// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The model is fetched, not committed. Without it (MIKE_SKIP_SPEECH_MODEL=1) the
// package still builds and the plugin reports Fluid Speech Mini unavailable.
let modelPath = "ios/Sources/MikeSpeechPlugin/FluidSpeechMini"
let modelDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(modelPath)
let hasModel = FileManager.default.fileExists(atPath: modelDirectory.path)

// Mike's on-device dictation plugin (README.md). The package and product
// name is what the Capacitor CLI derives from "@mike/speech".
//
// FluidAudio (Apache-2.0) runs Fluid Speech Mini and xn-ptts (MIT or
// Apache-2.0) runs Phonon. xn-ptts declares iOS 18 as its platform and Swift
// Package Manager refuses a dependency with a higher floor than the package's
// own ("requires minimum platform version 18.0"), so the plugin's floor, and
// the app's deployment target, is 18. The models need iOS 18 anyway. The model files are fetched by
// `npm run speech-model` (never committed) into FluidSpeechMini/, which is
// copied into the app as a resource.
let package = Package(
    name: "MikeSpeech",
    platforms: [.iOS("18.0")],
    products: [
        .library(
            name: "MikeSpeech",
            targets: ["MikeSpeechPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7"),
        .package(url: "https://github.com/gradium-ai/xn-ptts.git", exact: "0.4.0")
    ],
    targets: [
        .target(
            name: "MikeSpeechPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "FluidAudio", package: "FluidAudio"),
                // Module PhononTTS. The model is downloaded by the app, not bundled.
                .product(name: "ptts", package: "xn-ptts")
            ],
            path: "ios/Sources/MikeSpeechPlugin",
            resources: hasModel ? [.copy("FluidSpeechMini")] : []),
        .testTarget(
            name: "MikeSpeechPluginTests",
            dependencies: ["MikeSpeechPlugin"],
            path: "ios/Tests/MikeSpeechPluginTests",
            resources: [.copy("Fixtures")])
    ]
)
