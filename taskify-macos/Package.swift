// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TaskifyMacPresentation",
    platforms: [.macOS(.v14)],
    products: [.library(name: "MacPresentation", targets: ["MacPresentation"])],
    dependencies: [.package(path: "../taskify-ios-native")],
    targets: [
        .target(name: "MacPresentation", dependencies: [.product(name: "TaskifyCore", package: "taskify-ios-native")], path: "Sources/Presentation"),
        .testTarget(name: "MacPresentationTests", dependencies: ["MacPresentation"], path: "Tests"),
    ]
)
