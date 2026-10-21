// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PerpetoApple",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "PerpetoKit", targets: ["PerpetoKit"]),
        .library(name: "PerpetoUI", targets: ["PerpetoUI"]),
        .executable(name: "Perpeto", targets: ["PerpetoMac"]),
    ],
    targets: [
        // Models, Hub API v1 client, demo data, settings, design tokens and logo geometry.
        .target(name: "PerpetoKit"),
        // SwiftUI screens and components shared by macOS and, later, iPadOS/iOS.
        .target(name: "PerpetoUI", dependencies: ["PerpetoKit"]),
        // macOS app: window, sidebar, toolbar, menus and settings.
        .executableTarget(name: "PerpetoMac", dependencies: ["PerpetoKit", "PerpetoUI"]),
        .testTarget(name: "PerpetoKitTests", dependencies: ["PerpetoKit"]),
    ]
)
