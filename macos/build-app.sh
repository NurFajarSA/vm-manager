#!/bin/zsh
set -euo pipefail

here=${0:A:h}
out=${1:-$here/../dist}
app="$out/VM Manager.app"

version=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$here/../package.json")
[[ -n "$version" ]] || { echo "could not read version from package.json" >&2; exit 1; }

# Link against the SDK in use. Without these flags the binary records an older SDK and
# macOS 26 and later draw the app with the old design instead of the current one.
sdk=$(xcrun --sdk macosx --show-sdk-version)
link_sdk=(-Xlinker -platform_version -Xlinker macos -Xlinker 15.0 -Xlinker "$sdk")
swift build --package-path "$here" -c release "${link_sdk[@]}"
bin="$(swift build --package-path "$here" -c release "${link_sdk[@]}" --show-bin-path)/VMManager"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/VMManager"
cp "$here/icon/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
if [[ -x "$out/vm" ]]; then
  cp "$out/vm" "$app/Contents/Resources/vm"
fi
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VM Manager</string>
  <key>CFBundleDisplayName</key><string>VM Manager</string>
  <key>CFBundleIdentifier</key><string>app.vm-manager</string>
  <key>CFBundleExecutable</key><string>VMManager</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null
echo "$app"
