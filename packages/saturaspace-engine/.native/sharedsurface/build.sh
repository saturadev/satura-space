#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="SaturaSharedSurface"
OUT="$DIR/../../Runtime/Plugins/macOS/$NAME.bundle"
SRC="$DIR/SharedSurfaceMetal.mm"

CC="$(xcrun --sdk macosx --find clang++)"
SDK="$(xcrun --sdk macosx --show-sdk-path)"

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.saturaspace.sharedsurface</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
PLIST

FLAGS="-O2 -fobjc-arc -fvisibility=hidden -mmacosx-version-min=11.0 -isysroot $SDK -I$DIR \
  -framework Metal -framework IOSurface -framework Foundation -framework CoreFoundation"

if "$CC" -arch arm64 -arch x86_64 -bundle $FLAGS -o "$OUT/Contents/MacOS/$NAME" "$SRC" 2>/dev/null; then
  echo "built universal (arm64 + x86_64)"
else
  echo "universal build failed; host arch only"
  "$CC" -bundle $FLAGS -o "$OUT/Contents/MacOS/$NAME" "$SRC"
fi

strip -x "$OUT/Contents/MacOS/$NAME" || true

echo "output: $OUT"
lipo -info "$OUT/Contents/MacOS/$NAME" 2>/dev/null || true
nm -gU "$OUT/Contents/MacOS/$NAME" 2>/dev/null | grep -E "satura_ss|UnityPlugin" || true
