#!/bin/sh
# Build a macOS installer for Bowerbird: Bowerbird.app, then a DMG.
#
# Usage (from the repo root):
#   ./scripts/package-mac.sh            # arm64, Electron version from node_modules
#   ARCH=x64 ./scripts/package-mac.sh   # Intel Macs
#
# On a Mac, the DMG is made with hdiutil (the native, reliable path)
# and the .icns with iconutil. On Linux, the DMG needs hfsprogs
# (mkfs.hfsplus) plus libdmg-hfsplus (hdutil + dmg binaries); if
# those are missing the script still leaves a working .app and a
# .zip of it, and says exactly which tools are missing.
#
# The app is NOT signed or notarized by this script: a recipient
# opening a shared, unsigned app must right-click it and choose
# Open the first time. To sign it, on a Mac with a Developer ID
# certificate run:
#   codesign --deep --force --options runtime \
#     --sign "Developer ID Application: Your Name (TEAMID)" \
#     dist-mac/Bowerbird.app
# and then notarize the DMG with xcrun notarytool (see Apple docs).
# Sharing a signed + notarized build is the only way to avoid the
# Gatekeeper warning entirely; this script does not pretend otherwise.
set -eu
cd "$(dirname "$0")/.."

ARCH="${ARCH:-arm64}"
VERSION="$(node -e "console.log(require('./package.json').version)")"
# node_modules is gitignored, so a zip download does not contain it.
# Fail with the actual fix instead of a Node stack trace.
if [ ! -f node_modules/electron/package.json ]; then
  echo "!! Dependencies are not installed in this folder."
  echo "!! Run this first, then run this script again:"
  echo "!!   npm install"
  exit 1
fi
ELECTRON_VERSION="$(node -e "console.log(require('./node_modules/electron/package.json').version)")"
OUT="dist-mac"
APP="$OUT/Bowerbird.app"
DMG="$OUT/Bowerbird-$VERSION-$ARCH.dmg"

echo "== Bowerbird $VERSION for macOS ($ARCH), Electron $ELECTRON_VERSION"

# 1. Build the web app.
npm run build
# Build identifier, shown in Settings → General → Data, so a
# user can tell which packaged build they are actually running.
git rev-parse --short HEAD > dist/build-id.txt 2>/dev/null || echo "unknown" > dist/build-id.txt

# 2. Get the macOS Electron runtime.
ELECTRON_ZIP="/tmp/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
if [ ! -f "$ELECTRON_ZIP" ]; then
  echo "-- downloading Electron $ELECTRON_VERSION (darwin-$ARCH)"
  curl -L -o "$ELECTRON_ZIP" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-$ARCH.zip"
fi

# 3. Assemble the .app bundle from Electron.app.
rm -rf "$OUT" "$APP"
mkdir -p "$OUT"
unzip -q "$ELECTRON_ZIP" "Electron.app/*" -d "$OUT/tmp-electron"
mv "$OUT/tmp-electron/Electron.app" "$APP"
rm -rf "$OUT/tmp-electron"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Bowerbird"

# App files: dist, electron-dist (the compiled main process,
# including peek.html, copied there by the build), and the
# showcase assets the first-run board copies from
# (assetsDir() looks for sample.pdf in assets/).
mkdir -p "$APP/Contents/Resources/app"
cp -r dist electron-dist "$APP/Contents/Resources/app/"
# Bundled plugins (see plugins/README.md): same API as user plugins,
# shipped inside the app. Copy only if the folder exists, so a
# checkout without bundled plugins still packages cleanly.
if [ -d plugins ]; then
  cp -r plugins "$APP/Contents/Resources/app/"
fi
mkdir -p "$APP/Contents/Resources/app/assets"
cp assets/icon.png assets/sample.pdf assets/welcome-bower.jpg \
   assets/welcome-birdsong.mp3 assets/welcome-video.mp4 \
   "$APP/Contents/Resources/app/assets/"
cat > "$APP/Contents/Resources/app/package.json" <<EOF
{
  "name": "bowerbird",
  "version": "$VERSION",
  "private": true,
  "main": "electron-dist/main.js"
}
EOF

# 4. Icon: .icns, plus the Info.plist that points at it.
if [ "$(uname)" = "Darwin" ] && command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns assets/icon.iconset -o "$APP/Contents/Resources/Bowerbird.icns"
else
  python3 scripts/make-icns.py assets/icon.png "$APP/Contents/Resources/Bowerbird.icns"
fi
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Bowerbird</string>
  <key>CFBundleDisplayName</key>
  <string>Bowerbird</string>
  <key>CFBundleIdentifier</key>
  <string>works.wren.bowerbird</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleExecutable</key>
  <string>Bowerbird</string>
  <key>CFBundleIconFile</key>
  <string>Bowerbird</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "== built $APP"
find "$APP/Contents/Resources/app" -maxdepth 1 | sort

# 5. DMG with a drag-to-Applications layout.
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$APP" "$STAGE/"
if [ "$(uname)" = "Darwin" ]; then
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG"
  hdiutil create -volname Bowerbird -srcfolder "$STAGE" -ov -format UDZO "$DMG"
elif command -v mkfs.hfsplus >/dev/null 2>&1 && command -v hdutil >/dev/null 2>&1 && command -v dmg >/dev/null 2>&1; then
  # Linux path, the one Firefox uses: HFS+ image, populate, compress.
  # Populate via a tar archive and hdutil untar, NOT hfsplus
  # addall: addall follows the framework symlinks (Versions/Current
  # -> A and friends) and duplicates the whole framework until the
  # image runs out of space. Untar preserves symlinks as symlinks,
  # so the app stays its normal size. No Applications shortcut in
  # the Linux-built DMG (libdmg has no way to add one here); the
  # recipient drags the app to Applications themselves. The Mac
  # path above does include the shortcut, via hdiutil.
  APP_SIZE="$(du -sk "$STAGE" | cut -f1)"
  IMG_SIZE_MB=$(( (APP_SIZE / 1024) + 50 ))
  HFS="$OUT/bowerbird.hfs"
  dd if=/dev/zero of="$HFS" bs=1M count="$IMG_SIZE_MB" status=none
  mkfs.hfsplus -v Bowerbird "$HFS"
  (cd "$STAGE" && tar -cf "../bowerbird.tar" .)
  hdutil "$HFS" untar "$OUT/bowerbird.tar"
  rm -f "$DMG"
  dmg build "$HFS" "$DMG"
  rm -f "$HFS" "$OUT/bowerbird.tar"
else
  echo "!! DMG tools missing (need mkfs.hfsplus + libdmg-hfsplus on Linux, or hdiutil on macOS)"
  echo "!! leaving $APP and a zip instead:"
  (cd "$STAGE" && zip -qr "../Bowerbird-$VERSION-$ARCH.zip" Bowerbird.app)
fi
rm -rf "$STAGE"
echo "== done. Files in $OUT:"
ls -lh "$OUT"
