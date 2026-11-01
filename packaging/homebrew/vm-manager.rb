# typed: strict
# frozen_string_literal: true

# Template for Casks/vm-manager.rb in the NurFajarSA/homebrew-tap repository.
# After a release is published, scripts/update-cask.sh <version> <tap-checkout> fills in the checksum and copies it there.
cask "vm-manager" do
  version "1.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/NurFajarSA/vm-manager/releases/download/v#{version}/VMManager-#{version}-macos-arm64.zip"
  name "VM Manager"
  desc "SSH server inventory with a menu bar app and supervised access for Claude agents"
  homepage "https://github.com/NurFajarSA/vm-manager"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "VM Manager.app"
  binary "#{appdir}/VM Manager.app/Contents/Resources/vm"

  # Releases without a Developer ID are ad-hoc signed. Without this, Gatekeeper blocks the app
  # and silently kills the bundled vm, so the menu bar app and the MCP server never start.
  postflight_steps do
    run "/usr/bin/xattr", args:         ["-dr", "com.apple.quarantine", "{{appdir}}/VM Manager.app"],
                          must_succeed: false
  end

  uninstall launchctl: "app.vm-manager.menubar",
            quit:      "app.vm-manager"

  zap trash: "~/.config/vm-manager"

  caveats <<~EOS
    Set up the login item, ~/.local/bin/vm and the MCP server for Claude Code,
    and run this again after every upgrade:
      vm install --app "#{appdir}/VM Manager.app"

    Before uninstalling, remove the MCP server and ~/.local/bin/vm it added:
      vm uninstall

    Your server list stays in ~/.config/vm-manager and passwords stay in the Keychain
    unless you run `brew uninstall --zap`.
  EOS
end
