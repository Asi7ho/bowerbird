# Bowerbird (Swift) — one-command run and test.
# Run `just` to launch the app, `just test` to run the tests.
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

# Verify like CI does: build, then test.
check: build test

# Remove the build output.
clean:
    swift package --package-path swift clean
