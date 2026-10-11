// swift-tools-version: 5.9
import PackageDescription

// Mike's on-device dictation plugin (README.md). The package and product
// name is what the Capacitor CLI derives from "@mike/speech".
let package = Package(
    name: "MikeSpeech",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MikeSpeech",
            targets: ["MikeSpeechPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "MikeSpeechPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/MikeSpeechPlugin")
    ]
)
