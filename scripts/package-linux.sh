#!/bin/sh
# Build a Linux package for Bowerbird: a bowerbird binary folder,
# then a tarball of it.
#
# Usage (from the repo root):
#   ./scripts/package-linux.sh
#
# The tarball contains a `bowerbird` folder with the binary, the
# app files, a bowerbird.png icon and a bowerbird.desktop file, so
# it runs as-is after unpacking and can be added to a launcher.
# There is no .deb or AppImage here: the tarball is the portable
# form, and it is what the release ships.
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
OUT="dist-linux"
APP="$OUT/bowerbird"
TARBALL="Bowerbird-$VERSION-linux-$ARCH.tar.gz"

echo "== Bowerbird $VERSION for Linux ($ARCH), Electron $ELECTRON_VERSION"

# 1. Build the web app.
npm run build
# Build identifier, shown in Settings → General → Data, so a
# user can tell which packaged build they are actually running.
git rev-parse --short HEAD > dist/build-id.txt 2>/dev/null || echo "unknown" > dist/build-id.txt

# 2. Get the Linux Electron runtime.
ELECTRON_ZIP="/tmp/electron-v$ELECTRON_VERSION-linux-$ARCH.zip"
if [ ! -f "$ELECTRON_ZIP" ]; then
  echo "-- downloading Electron $ELECTRON_VERSION (linux-$ARCH)"
  curl -L -o "$ELECTRON_ZIP" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-$ARCH.zip"
fi

# 3. Assemble the app folder from the Electron distribution.
rm -rf "$OUT" "bowerbird"
mkdir -p "$OUT"
unzip -q "$ELECTRON_ZIP" -d "$OUT/tmp-electron"
mv "$OUT/tmp-electron"/* "$OUT/"
rmdir "$OUT/tmp-electron"
mv "$OUT/electron" "$APP"

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
cp assets/icon.png assets/sample.pdf assets/welcome-bower.jpg \
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

# 4. Launcher entry and icon, so the unpacked folder can be added
# to a desktop menu. The icon is the app's own, not Electron's.
cp assets/icon.png "$OUT/bowerbird.png"
cat > "$OUT/bowerbird.desktop" <<EOF
[Desktop Entry]
Name=Bowerbird
Comment=An infinite whiteboard for creatives
Exec=bowerbird
Icon=bowerbird
Terminal=false
Type=Application
Categories=Graphics;Office;
EOF

echo "== built $APP"
find "$OUT/resources/app" -maxdepth 1 | sort

# 5. Tarball of the folder, named for the release.
rm -f "$TARBALL"
mv "$OUT" bowerbird
tar -czf "$TARBALL" bowerbird
mv bowerbird "$OUT"
echo "== done:"
ls -lh "$TARBALL" "$OUT"
