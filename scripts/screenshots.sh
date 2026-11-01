#!/bin/zsh
# Regenerates the README screenshots in docs/images from the demo fixtures in scripts/demo.
# Needs a built app (bun run build:app) and Screen Recording permission for the terminal that runs it.
set -euo pipefail

root=${0:A:h:h}
app="$root/dist/VM Manager.app/Contents/MacOS/VMManager"
out="$root/docs/images"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
xcrun swiftc -O -o "$work/window-id" "$root/scripts/demo/window-id.swift"

# A throwaway home keeps your own servers out of the pictures and the demo out of your preferences.
home="$work/home"
mkdir -p "$home/.local/bin" "$home/.config/vm-manager/approvals" "$home/Library/LaunchAgents"
cp "$root"/scripts/demo/{vm,*.json} "$home/.local/bin/"
touch "$home/Library/LaunchAgents/app.vm-manager.menubar.plist"
export CFFIXED_USER_HOME="$home" VM_MANAGER_HOME="$home/.config/vm-manager" VM_MANAGER_BIN="$home/.local/bin/vm"

# capture <file> <appearance> [VAR=value ...] [-- app arguments]
capture() {
  local file=$1 appearance=$2; shift 2
  local env_args=() app_args=()
  while (( $# )) && [[ $1 != -- ]]; do env_args+=("$1"); shift; done
  (( $# )) && shift && app_args=("$@")
  env VM_MANAGER_APPEARANCE=$appearance "${env_args[@]}" "$app" -AppleLanguages "(en)" -AppleLocale en_US -ApplePersistenceIgnoreState YES "${app_args[@]}" >/dev/null 2>&1 &
  local pid=$! window=""
  for _ in {1..20}; do
    sleep 0.5
    window=$("$work/window-id" "$pid" 2>/dev/null) && break
  done
  sleep 2
  if [[ -n $window ]]; then
    screencapture -x -o -l "${window% *}" "$out/$file" && echo "$out/$file"
    # A window on a Retina screen comes out at 2x; keep every picture at 1x so they match.
    local pixels=$(sips -g pixelWidth "$out/$file" | awk '/pixelWidth/{print $2}')
    (( pixels >= 2 * ${window#* } )) && sips --resampleWidth $(( pixels / 2 )) "$out/$file" >/dev/null
  else
    echo "no window for $file" >&2
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

capture menu-bar.png light VM_MANAGER_PREVIEW_PANEL=1
capture menu-bar-dark.png dark VM_MANAGER_PREVIEW_PANEL=1
capture menu-bar-inactive.png light VM_MANAGER_PREVIEW_PANEL=1 VM_MANAGER_SNAPSHOT_INACTIVE=1
capture approvals.png light VM_MANAGER_OPEN_APPROVALS=1
capture approvals-dark.png dark VM_MANAGER_OPEN_APPROVALS=1
capture settings-server.png light VM_MANAGER_OPEN_SETTINGS=1 VM_MANAGER_OPEN_ROUTE=shop-web-prod
for pane in general servers agent approvals audit network about; do
  capture "settings-$pane.png" light VM_MANAGER_OPEN_SETTINGS=1 -- -settingsPane "$pane"
done
