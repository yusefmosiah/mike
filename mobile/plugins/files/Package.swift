// swift-tools-version: 5.9
import PackageDescription

// Mike's file plugin (README.md). The package and product name is what the
// Capacitor CLI derives from "@mike/files".
let package = Package(
    name: "MikeFiles",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MikeFiles",
            targets: ["MikeFilesPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "MikeFilesPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/MikeFilesPlugin")
    ]
)
