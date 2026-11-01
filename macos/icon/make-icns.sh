#!/bin/zsh
# Redraws AppIcon-1024.png with make-icon.swift and packs every size into AppIcon.icns.
set -euo pipefail
here=${0:A:h}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swift "$here/make-icon.swift" "$here/AppIcon-1024.png"
set=$work/AppIcon.iconset
mkdir -p "$set"
for px in 16 32 128 256 512; do
  sips -z $px $px "$here/AppIcon-1024.png" --out "$set/icon_${px}x${px}.png" >/dev/null
  sips -z $((px * 2)) $((px * 2)) "$here/AppIcon-1024.png" --out "$set/icon_${px}x${px}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o "$here/AppIcon.icns"
echo "$here/AppIcon.icns"
