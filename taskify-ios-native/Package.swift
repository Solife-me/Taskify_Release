// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "TaskifyNative",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "TaskifyCore", targets: ["TaskifyCore"]),
        .library(name: "TaskifyWatchShared", targets: ["TaskifyWatchShared"]),
    ],
    dependencies: [
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift.git", exact: "1.10.0"),
        .package(
            url: "https://github.com/21-DOT-DEV/swift-secp256k1.git",
            exact: "0.23.2"
        ),
        .package(
            url: "https://github.com/cashubtc/cdk-swift.git",
            exact: "0.18.0"
        ),
        .package(
            url: "https://github.com/BlockchainCommons/URKit.git",
            revision: "ebba59b2e1538cb368d98147dd58c452e6d1dc47"
        ),
    ],
    targets: [
        .target(name: "TaskifyFileCipher", dependencies: [.product(name: "CryptoSwift", package: "CryptoSwift")]),
        .target(
            name: "TaskifyCore",
            dependencies: [
                "TaskifyWatchShared",
                "TaskifyFileCipher",
                .product(name: "P256K", package: "swift-secp256k1"),
                .product(name: "Cdk", package: "cdk-swift"),
                .product(name: "URKit", package: "URKit"),
            ],
            path: "Sources/TaskifyCore"
        ),
        .target(
            name: "TaskifyWatchShared",
            dependencies: [
                .product(name: "P256K", package: "swift-secp256k1"),
            ],
            path: "Sources/TaskifyWatchShared"
        ),
        .testTarget(
            name: "TaskifyCoreTests",
            dependencies: ["TaskifyCore", "TaskifyWatchShared"],
            path: "Tests/TaskifyCoreTests"
        ),
        // Compile the Watch transport, store, and image cache for deterministic runtime
        // tests without requiring a paired Watch or changing the Xcode app target.
        .target(
            name: "TaskifyWatchChatRuntime",
            dependencies: ["TaskifyWatchShared"],
            path: "Sources/TaskifyWatchApp",
            exclude: [
                "Info.plist", "TaskifyWatchApp.swift", "TaskifyWatchAppModel.swift",
                "TaskifyWatchRootView.swift", "TaskifyWatchChatView.swift",
                "TaskifyWatchIndependentClient.swift",
            ],
            sources: ["TaskifyWatchChatClient.swift", "TaskifyWatchChatStore.swift", "TaskifyWatchAvatarLoader.swift",
                      "TaskifyWatchPhotoLoader.swift", "TaskifyWatchViewCache.swift", "TaskifyWatchMarkdownCache.swift"]
        ),
        .testTarget(
            name: "TaskifyWatchChatRuntimeTests",
            dependencies: ["TaskifyWatchChatRuntime", "TaskifyWatchShared"],
            path: "Tests/TaskifyWatchChatRuntimeTests"
        ),
    ]
)
