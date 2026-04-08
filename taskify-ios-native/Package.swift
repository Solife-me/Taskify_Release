// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "TaskifyiOS",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(
            name: "TaskifyCore",
            targets: ["TaskifyCore"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/nostr-sdk/nostr-sdk-ios",
            from: "0.8.0"
        ),
        .package(
            url: "https://github.com/zeugmaster/CashuSwift",
            from: "0.1.0"
        ),
    ],
    targets: [
        .target(
            name: "TaskifyCore",
            dependencies: [
                "NostrSDK",
                "CashuSwift",
            ],
            path: "Sources/TaskifyCore",
            resources: [
                .process("Resources"),
            ]
        ),
        .testTarget(
            name: "TaskifyCoreTests",
            dependencies: ["TaskifyCore"],
            path: "Tests/TaskifyCoreTests"
        ),
    ]
)