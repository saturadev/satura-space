#!/bin/bash
# Build the window-suppression dylib injected into headless Unity clone editors.
# Universal arm64+arm64e is REQUIRED (plain arm64 silently fails to inject).
set -e
cd "$(dirname "$0")"
xcrun clang -arch arm64 -arch arm64e -dynamiclib -fno-objc-arc -O2 \
  -fvisibility=hidden \
  -framework AppKit -framework Foundation \
  -o winhook.dylib winhook.m
strip -x winhook.dylib || true
codesign -s - -f winhook.dylib
echo "built $(pwd)/winhook.dylib ($(lipo -archs winhook.dylib))"
