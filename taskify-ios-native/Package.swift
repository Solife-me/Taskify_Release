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
        .package(
            url: "https://github.com/21-DOT-DEV/swift-secp256k1.git",
            exact: "0.23.2"
        ),
        .package(
            url: "https://github.com/cashubtc/cdk-swift.git",
            exact: "0.17.3"
        ),
        .package(
            url: "https://github.com/BlockchainCommons/URKit.git",
            revision: "ebba59b2e1538cb368d98147dd58c452e6d1dc47"
        ),
    ],
    targets: [
        .target(
            name: "TaskifyCore",
            dependencies: [
                "TaskifyWatchShared",
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
    ]
)
