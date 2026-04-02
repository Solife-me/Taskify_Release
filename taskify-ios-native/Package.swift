// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TaskifyiOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "TaskifyCore", targets: ["TaskifyCore"]),
        .executable(name: "TaskifyApp", targets: ["TaskifyApp"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/Solife-me/nostr-sdk-ios.git",
            branch: "feat/public-nip44-conversation-key"
        ),
        .package(
            url: "https://github.com/GigaBitcoin/secp256k1.swift",
            exact: "0.12.2"
        ),
    ],
    targets: [
        .target(
            name: "TaskifyCore",
            dependencies: [
                .product(name: "NostrSDK", package: "nostr-sdk-ios"),
                .product(name: "secp256k1", package: "secp256k1.swift"),
            ],
            path: "Sources/TaskifyCore"
        ),
        .executableTarget(
            name: "TaskifyApp",
            dependencies: ["TaskifyCore"],
            path: "Sources/TaskifyApp"
        ),
        .testTarget(
            name: "TaskifyCoreTests",
            dependencies: ["TaskifyCore"],
            path: "Tests/TaskifyCoreTests"
        ),
    ]
)
