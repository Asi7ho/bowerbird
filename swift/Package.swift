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
        .target(name: "BowerbirdCore"),
        .executableTarget(name: "Bowerbird", dependencies: ["BowerbirdCore"]),
        .testTarget(name: "BowerbirdTests", dependencies: ["BowerbirdCore"], resources: [.copy("Fixtures")]),
    ]
)
