#!/bin/sh
# Installs VM Manager and the vm CLI from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/NurFajarSA/vm-manager/main/install.sh | sh
#
# Environment:
#   VM_MANAGER_VERSION   install this version (for example 1.0.0) instead of the latest
#   VM_MANAGER_BASE_URL  download from here instead of GitHub (a mirror, or file:// for testing)
#
# The release is checked against its published SHA-256, then `vm install` sets up the app,
# its login item, ~/.local/bin/vm and the MCP server for Claude Code.
set -eu

repo="NurFajarSA/vm-manager"
app_name="VM Manager.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "VM Manager runs on macOS only."
[ "$(uname -m)" = arm64 ] || fail "Releases are built for Apple silicon (arm64). Build from source on Intel Macs."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 15 ] || fail "macOS 15 or later is required (this Mac runs $(sw_vers -productVersion))."

version=${VM_MANAGER_VERSION:-}
if [ -z "$version" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") \
    || fail "could not reach GitHub to find the latest release."
  version=${latest##*/v}
  case $version in
    ''|*/*) fail "no published release found at https://github.com/$repo/releases" ;;
  esac
fi
version=${version#v}

base=${VM_MANAGER_BASE_URL:-https://github.com/$repo/releases/download/v$version}
zip="VMManager-$version-macos-arm64.zip"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

say "Downloading VM Manager $version"
curl -fL --progress-bar -o "$work/$zip" "$base/$zip" || fail "download failed: $base/$zip"
curl -fsSL -o "$work/$zip.sha256" "$base/$zip.sha256" || fail "checksum download failed: $base/$zip.sha256"

expected=$(cut -d' ' -f1 < "$work/$zip.sha256")
actual=$(shasum -a 256 "$work/$zip" | cut -d' ' -f1)
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $zip (expected $expected, got $actual)."
say "Checksum verified"

ditto -x -k "$work/$zip" "$work"
[ -x "$work/$app_name/Contents/Resources/vm" ] || fail "the release does not contain $app_name with the vm command."

"$work/$app_name/Contents/Resources/vm" install --app "$work/$app_name"

say ""
say "Done. VM Manager is in your menu bar, and vm is in ~/.local/bin."
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "Add ~/.local/bin to your PATH to use vm in a terminal:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile" ;;
esac
say "Next: run 'vm init' to create your server list, then 'vm add <name> --host <ip> --user <user> --key <file>'."
