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
        // secp256k1 — required for Nostr key ops and NIP-44 conversation key derivation.
        // Apple CryptoKit does not include secp256k1.
        .package(
            url: "https://github.com/21-DOT-DEV/swift-secp256k1.git",
            from: "0.21.0"
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
