# Bowerbird (Swift) — one-command run and test.
# Run `just` to launch the app, `just test` to run the tests.
# Run `just app` to build a real .app bundle and open it:
# `just` runs the raw executable, not a bundled app (no
# bundle identifier, no Info.plist), and the system treats
# a non-bundled process differently — trackpad gestures
# and window chrome can degrade. The bundle is the full app.
# The Swift package lives in `swift/`; every recipe runs
# from there, so you never have to `cd` into it.

# Launch the app (builds first if needed).
default: run

# Build the app and the tests.
build:
    swift build --package-path swift

# Run the test suite.
test:
    swift test --package-path swift

# Build, then launch the app.
run:
    swift run --package-path swift Bowerbird

# Build a proper macOS .app bundle and open it, so the app
# runs as a full app (bundle identifier, Info.plist) rather
# than a raw executable.
app:
    swift build --package-path swift -c release
    rm -rf Bowerbird.app
    mkdir -p Bowerbird.app/Contents/MacOS
    cp swift/.build/release/Bowerbird Bowerbird.app/Contents/MacOS/Bowerbird
    cp Info.plist Bowerbird.app/Contents/Info.plist
    open Bowerbird.app

# Verify like CI does: build, then test.
check: build test

# Remove the build output.
clean:
    swift package --package-path swift clean
