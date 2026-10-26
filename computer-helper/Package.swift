// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "ComputerHelper",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure parts: the wire protocol, configuration, policy and key parsing.
        .target(name: "ComputerHelperCore"),
        // The menu-bar app: transport, accessibility, screenshots and input.
        .executableTarget(
            name: "ComputerHelper",
            dependencies: ["ComputerHelperCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
        .testTarget(name: "ComputerHelperCoreTests", dependencies: ["ComputerHelperCore"]),
    ]
)
