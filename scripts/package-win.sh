#!/bin/sh
# Build a Windows installer for Bowerbird: a Bowerbird.exe folder,
# then a zip of it.
#
# Usage (from the repo root, in Git Bash on Windows):
#   ./scripts/package-win.sh
#
# The app is NOT signed by this script: a recipient opening a
# shared, unsigned exe gets a SmartScreen warning the first time.
# To sign it, on Windows with a code-signing certificate run:
#   signtool sign /fd SHA256 /a dist-win/Bowerbird.exe
# Sharing a signed build is the only way to avoid the warning
# entirely; this script does not pretend otherwise.
#
# The icon is set with rcedit (downloaded from GitHub, pinned to
# v2.0.0). If rcedit fails, the script warns loudly and continues
# with the default Electron icon — the exe still works.
set -eu
cd "$(dirname "$0")/.."

ARCH="${ARCH:-x64}"
VERSION="${VERSION:-$(node -e "console.log(require('./package.json').version)")}"
# node_modules is gitignored, so a zip download does not contain it.
# Fail with the actual fix instead of a Node stack trace.
if [ ! -f node_modules/electron/package.json ]; then
  echo "!! Dependencies are not installed in this folder."
  echo "!! Run this first, then run this script again:"
  echo "!!   npm install"
  exit 1
fi
ELECTRON_VERSION="$(node -e "console.log(require('./node_modules/electron/package.json').version)")"
OUT="dist-win"
APP="$OUT/Bowerbird.exe"
ZIP="$OUT/Bowerbird-$VERSION-win-$ARCH.zip"

echo "== Bowerbird $VERSION for Windows ($ARCH), Electron $ELECTRON_VERSION"

# 1. Build the web app.
npm run build
# Build identifier, shown in Settings → General → Data, so a
# user can tell which packaged build they are actually running.
git rev-parse --short HEAD > dist/build-id.txt 2>/dev/null || echo "unknown" > dist/build-id.txt

# 2. Get the Windows Electron runtime.
ELECTRON_ZIP="/tmp/electron-v$ELECTRON_VERSION-win32-$ARCH.zip"
if [ ! -f "$ELECTRON_ZIP" ]; then
  echo "-- downloading Electron $ELECTRON_VERSION (win32-$ARCH)"
  curl -L -o "$ELECTRON_ZIP" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-$ARCH.zip"
fi

# 3. Assemble the app folder from the Electron distribution.
rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q "$ELECTRON_ZIP" -d "$OUT/tmp-electron"
mv "$OUT/tmp-electron"/* "$OUT/"
rmdir "$OUT/tmp-electron"
mv "$OUT/electron.exe" "$APP"

# App files: dist, electron-dist (the compiled main process,
# including peek.html, copied there by the build), and the
# showcase assets the first-run board copies from
# (assetsDir() looks for sample.pdf in assets/).
mkdir -p "$OUT/resources/app"
cp -r dist electron-dist "$OUT/resources/app/"
# Bundled plugins (see plugins/README.md): same API as user plugins,
# shipped inside the app. Copy only if the folder exists, so a
# checkout without bundled plugins still packages cleanly.
if [ -d plugins ]; then
  cp -r plugins "$OUT/resources/app/"
fi
mkdir -p "$OUT/resources/app/assets"
cp assets/icon.png assets/icon.ico assets/sample.pdf assets/welcome-bower.jpg \
   assets/welcome-birdsong.mp3 assets/welcome-video.mp4 \
   "$OUT/resources/app/assets/"
cat > "$OUT/resources/app/package.json" <<EOF
{
  "name": "bowerbird",
  "version": "$VERSION",
  "private": true,
  "main": "electron-dist/main.js"
}
EOF

# 4. Icon: replace the Electron icon on the exe with the app's own.
# rcedit is a Windows exe, so this only runs on Windows; on any
# other OS the script warns and leaves the default icon.
if [ "$(uname -o 2>/dev/null || echo "")" = "Msys" ] || [ "$(uname -s)" = "MINGW64_NT" ] || [ "$(uname -s)" = "MSYS_NT" ]; then
  RCEDIT="/tmp/rcedit-x64.exe"
  if [ ! -f "$RCEDIT" ]; then
    echo "-- downloading rcedit v2.0.0"
    curl -L -o "$RCEDIT" \
      "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" || true
  fi
  if [ -f "$RCEDIT" ]; then
    echo "-- setting the app icon on Bowerbird.exe"
    "$RCEDIT" "$APP" --set-icon "assets/icon.ico" || {
      echo "!! rcedit failed — Bowerbird.exe keeps the default Electron icon"
    }
  else
    echo "!! rcedit download failed — Bowerbird.exe keeps the default Electron icon"
  fi
else
  echo "!! not on Windows, so the icon was not set — Bowerbird.exe keeps the default Electron icon"
fi

echo "== built $APP"
find "$OUT/resources/app" -maxdepth 1 | sort

# 5. Zip the folder. PowerShell's Compress-Archive is the reliable
# zip on a Windows runner (Git Bash has no zip by default).
rm -f "$ZIP"
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command "Compress-Archive -Path '$OUT' -DestinationPath '$ZIP'"
elif command -v zip >/dev/null 2>&1; then
  (cd "$OUT" && zip -qr "../$ZIP" .)
else
  echo "!! no zip tool found (need PowerShell or zip) — leaving the $OUT folder unzipped"
fi
echo "== done. Files in $OUT:"
ls -lh "$OUT"
