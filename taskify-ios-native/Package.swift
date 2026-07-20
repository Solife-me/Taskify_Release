// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "TaskifyNative",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "TaskifyCore", targets: ["TaskifyCore"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/21-DOT-DEV/swift-secp256k1.git",
            exact: "0.21.1"
        ),
    ],
    targets: [
        .target(
            name: "TaskifyCore",
            dependencies: [
                .product(name: "P256K", package: "swift-secp256k1"),
            ],
            path: "Sources/TaskifyCore"
        ),
        .testTarget(
            name: "TaskifyCoreTests",
            dependencies: ["TaskifyCore"],
            path: "Tests/TaskifyCoreTests"
        ),
    ]
)
