// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Bowerbird",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Bowerbird", targets: ["Bowerbird"]),
        .library(name: "BowerbirdCore", targets: ["BowerbirdCore"]),
    ],
    targets: [
        // Headless core: the board model, the store, the
        // plugin host. It knows nothing about UI.
        .target(name: "BowerbirdCore"),
        // Board UI: the AppKit viewport, the Metal grid and
        // ink layer, the card host and card views. It knows
        // the core, never the other way round.
        .target(
            name: "BoardUI",
            dependencies: ["BowerbirdCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Metal"),
                .linkedFramework("MetalKit"),
                .linkedFramework("QuartzCore"),
            ]
        ),
        .executableTarget(name: "Bowerbird", dependencies: ["BowerbirdCore", "BoardUI"]),
        .testTarget(name: "BowerbirdTests", dependencies: ["BowerbirdCore"], resources: [.copy("Fixtures")]),
    ]
)
