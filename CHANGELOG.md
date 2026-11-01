# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-01

First release.

### Added

- Inventory: one list of servers in `~/.config/vm-manager/vms.json` with name, group, prod or dev, address, port, user, key file or password, network (public, OpenVPN Connect or Tailscale), other hostnames, notes, agent policy and whether it is active. Every write is validated, locked and atomic.
- `vm init` creates an empty list; `vm init --example` writes made-up servers on documentation addresses. Neither overwrites an existing list.
- `vm add`, `vm edit`, `vm remove`, `vm list` and `vm status` (a TCP check of each SSH port, with VPN and Tailscale state).
- Passwords in the login Keychain (service `vm-manager`). `vm ssh <name>` signs in through a one-time `SSH_ASKPASS` session that only answers `ssh`, for that server, for a password prompt.
- `vm key-setup` copies an SSH key to a password server, checks it, and switches the server to key login.
- `vm sync-ssh` writes `~/.ssh/config.d/vm-manager.conf` and an `Include` line at the top of `~/.ssh/config`, after a backup, so `ssh <name>` works everywhere.
- OpenVPN detection from the subnets your profile routes, stored in `vms.json` as `networks.openvpn.routes` and set with `vm vpn-routes` or in **Settings › Network**. There is no default subnet; until one is set the app shows **VPN subnet not set**.
- MCP server `vm-manager` with `list_vms`, `vm_read`, `vm_change` and `vm_logs`. Three policies per server (`free`, `read-free-change-approve`, `none`), a short read-only allowlist, a hard blocklist that holds even with approval, `confirm_destructive` for `DROP`/`TRUNCATE`, and an audit log of every command without its output.
- Approvals: a change on a `read-free-change-approve` server waits up to 10 minutes for you to approve the exact command in a notification, the approvals window, **Settings › Approvals** or `vm approve`.
- `vm exec`, `vm check` and `vm policy` to run or test commands under the same rules from a terminal.
- Menu bar app "VM Manager" with a module per group, PROD and DEV badges, reachability dots, waiting approvals at the top, and Copy IP, Copy SSH Command, Open in Zed and Edit… on each server.
- Server picker: opening VM Manager from the Dock, Finder or Spotlight shows a Chrome-style window with a card per active server; one click opens `vm ssh <name>` in Terminal. Also under **Choose Server…** in the menu bar. It stays hidden when the app starts at login (the login item passes `--at-login`) and can be turned off from its own checkbox.
- Settings window in the System Settings style: General, Servers, Agent Access, Approvals, Audit Log, Network and About.
- `vm install` and `vm uninstall` for the binary, the menu bar app and its login item, and the MCP server. `vm install` clears the quarantine flag on what it installs, so ad-hoc signed releases run, and leaves an app that is already in `/Applications` or `~/Applications` in place.
- `install.sh`: a one-line installer that downloads the latest release, verifies its SHA-256 and runs `vm install`.
- Release packaging: `scripts/package-release.sh` builds a zip of the app and a tarball of `vm`, with optional Developer ID signing and notarization, and a Homebrew cask template with `scripts/update-cask.sh`.
- `scripts/screenshots.sh` regenerates the README screenshots from demo fixtures in `scripts/demo`.

[Unreleased]: https://github.com/NurFajarSA/vm-manager/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NurFajarSA/vm-manager/releases/tag/v1.0.0
