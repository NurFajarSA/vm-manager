// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "VMManager",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "VMManager", path: "Sources/VMManager")
    ],
    swiftLanguageModes: [.v5]
)
