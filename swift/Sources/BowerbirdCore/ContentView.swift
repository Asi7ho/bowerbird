import SwiftUI

/// The board. M0 is only a placeholder window; the canvas,
/// cards and tools land in M2–M3 (see docs/macos/PLAN.md).
public struct ContentView: View {
    public init() {}

    public var body: some View {
        Text("Bowerbird")
            .frame(minWidth: 800, minHeight: 600)
    }
}
