#!/bin/sh
# Build a macOS installer for the Bowerbird demo: "Bowerbird Demo",
# a DMG other people can install, with demo mode built in.
#
# Usage (from the repo root):
#   ./scripts/package-demo.sh            # arm64
#   ARCH=x64 ./scripts/package-demo.sh   # Intel Macs
#   ./scripts/demo.sh                    # same thing, via the demo script
#
# How the demo is built in, with no environment variable for the
# installer to set: the demo app is the normal app plus one extra
# file, Contents/Resources/app/demo-mode, and main.js treats that
# file as demo mode (see the DEMO check in electron/main.js).
# The normal app does not contain that file, so it is unaffected.
# The demo bundle also gets its own name and bundle identifier
# (Bowerbird Demo / works.wren.bowerbird.demo), so it installs
# side by side with a real Bowerbird instead of replacing it.
#
# The demo DMG is unsigned, like the normal one: a recipient must
# right-click it and choose Open the first time.
#
# On a Mac, the DMG is made with hdiutil. On Linux it needs
# hfsprogs plus libdmg-hfsplus; if those are missing the script
# still leaves a working demo .app and a .zip of it, and says so.
set -eu
cd "$(dirname "$0")/.."

ARCH="${ARCH:-arm64}"
VERSION="$(node -e "console.log(require('./package.json').version)")"
if [ ! -f node_modules/electron/package.json ]; then
  echo "!! Dependencies are not installed in this folder."
  echo "!! Run this first, then run this script again:"
  echo "!!   npm install"
  exit 1
fi

# 1. Build the normal app first, so the demo is exactly that app
#    plus the demo marker and its own bundle identity.
./scripts/package-mac.sh
NORMAL_APP="dist-mac/Bowerbird.app"
if [ ! -d "$NORMAL_APP" ]; then
  echo "!! Normal app build did not produce $NORMAL_APP"
  exit 1
fi

# 2. Stage the demo app. Tar, not cp, so the Electron framework
#    symlinks stay symlinks (cp would risk duplicating them).
OUT="dist-mac-demo"
DEMO_APP="$OUT/Bowerbird Demo.app"
DMG="$OUT/Bowerbird-Demo-$VERSION-$ARCH.dmg"
rm -rf "$OUT"
mkdir -p "$OUT"
(cd dist-mac && tar -cf - Bowerbird.app) | (cd "$OUT" && tar --no-same-owner -xf -)
mv "$OUT/Bowerbird.app" "$DEMO_APP"

# 3. Demo identity: name, display name and bundle identifier only.
#    The executable and icon names stay "Bowerbird", because those
#    are the actual file names inside the bundle.
python3 - "$DEMO_APP/Contents/Info.plist" << 'PY'
import re, sys
p = sys.argv[1]
t = open(p, encoding="utf-8").read()
def set_value(text, key, value):
    pattern = r"(<key>" + key + r"</key>\s*<string>)[^<]*(</string>)"
    new, n = re.subn(pattern, r"\g<1>" + value + r"\g<2>", text, count=1)
    if n != 1:
        raise SystemExit("could not set " + key + " in " + p)
    return new
t = set_value(t, "CFBundleName", "Bowerbird Demo")
t = set_value(t, "CFBundleDisplayName", "Bowerbird Demo")
t = set_value(t, "CFBundleIdentifier", "works.wren.bowerbird.demo")
open(p, "w", encoding="utf-8").write(t)
print("demo Info.plist ok")
PY

# 4. The demo marker: this file alone is what makes the packaged
#    app a demo. It is created here, in the staging folder only —
#    never at the repo root, where it would turn source runs
#    into demos.
printf 'Demo mode: this build saves nothing.\n' > "$DEMO_APP/Contents/Resources/app/demo-mode"

echo "== built $DEMO_APP"
find "$DEMO_APP/Contents/Resources/app" -maxdepth 1 | sort

# 5. DMG with a drag-to-Applications layout.
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$DEMO_APP" "$STAGE/"
if [ "$(uname)" = "Darwin" ]; then
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG"
  hdiutil create -volname "Bowerbird Demo" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
elif command -v mkfs.hfsplus >/dev/null 2>&1 && command -v hdutil >/dev/null 2>&1 && command -v dmg >/dev/null 2>&1; then
  APP_SIZE="$(du -sk "$STAGE" | cut -f1)"
  IMG_SIZE_MB=$(( (APP_SIZE / 1024) + 50 ))
  HFS="$OUT/bowerbird-demo.hfs"
  dd if=/dev/zero of="$HFS" bs=1M count="$IMG_SIZE_MB" status=none
  mkfs.hfsplus -v "Bowerbird Demo" "$HFS"
  (cd "$STAGE" && tar -cf "../bowerbird-demo.tar" .)
  hdutil "$HFS" untar "$OUT/bowerbird-demo.tar"
  rm -f "$DMG"
  dmg build "$HFS" "$DMG"
  rm -f "$HFS" "$OUT/bowerbird-demo.tar"
else
  echo "!! DMG tools missing (need mkfs.hfsplus + libdmg-hfsplus on Linux, or hdiutil on macOS)"
  echo "!! leaving $DEMO_APP and a zip instead:"
  (cd "$STAGE" && zip -qr "../Bowerbird-Demo-$VERSION-$ARCH.zip" "Bowerbird Demo.app")
fi
rm -rf "$STAGE"
echo "== done. Files in $OUT:"
ls -lh "$OUT"
