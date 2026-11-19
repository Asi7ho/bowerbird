# Bowerbird (Swift) — one-command run and test.
# Run `just` to build the .app bundle and open it, `just test`
# to run the tests. `just` opens the bundle, not the raw
# executable: `swift run` launches a non-bundled process
# (no bundle identifier, no Info.plist), and the system
# treats it differently — trackpad gestures and window
# chrome degrade (the resize cursor and the pinch did not
# work that way). The bundle is the full app.
# The Swift package lives in `swift/`; every recipe runs
# from there, so you never have to `cd` into it.

# Build the .app bundle and open it (builds first if needed).
default: app

# Build the app and the tests.
build:
    swift build --package-path swift

# Run the test suite.
test:
    swift test --package-path swift

# Launch the raw executable (fast, but not a full app —
# gestures and window chrome can degrade).
run:
    swift run --package-path swift Bowerbird

# Build a proper macOS .app bundle and open it, so the app
# runs as a full app (bundle identifier, Info.plist) rather
# than a raw executable.
app:
    swift build --package-path swift
    rm -rf Bowerbird.app
    mkdir -p Bowerbird.app/Contents/MacOS
    cp swift/.build/debug/Bowerbird Bowerbird.app/Contents/MacOS/Bowerbird
    cp Info.plist Bowerbird.app/Contents/Info.plist
    open Bowerbird.app

# Verify like CI does: build, then test.
check: build test

# Remove the build output.
clean:
    swift package --package-path swift clean
