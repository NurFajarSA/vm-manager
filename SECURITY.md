# Security

VM Manager keeps passwords for your servers and lets Claude agents run commands on them. This page says what it stores, where, and how to report a problem.

## What it stores and where

| Data | Location | Notes |
| --- | --- | --- |
| Server passwords | Login Keychain, service `vm-manager`, one item per server | Written through `security -i` on stdin, never as a command argument. Removed by `vm password <name> --delete` or `vm remove <name>`. |
| Server list | `~/.config/vm-manager/vms.json` (mode `0600`) | Names, addresses, users, key file paths, notes, policies and VPN subnets. No secrets. |
| Approval requests | `~/.config/vm-manager/approvals/` | The server, command, requester and reason. |
| Audit log | `~/.config/vm-manager/audit.jsonl` | Time, server, command, decision, exit code, duration and output size. Never the output. Credentials typed into a command are masked. |
| Reachability | `~/.config/vm-manager/status.json` | The last TCP check of each SSH port. |
| Log | `~/.config/vm-manager/vm-manager.log` | Errors, never passwords. |
| SSH config | `~/.ssh/config.d/vm-manager.conf`, written only by `vm sync-ssh` | `Host` blocks with address, user, port and key path. |

Network traffic goes only to your own servers: `ssh` sessions, and a plain TCP connection to each SSH port for the status check, which never signs in. Network state comes from `netstat`, `route` and `tailscale status` on this Mac. There is no telemetry and no server of this project.

## The agent boundary

Agents are supervised only when the `vm-manager` MCP server is their sole route to your servers. An agent with an unrestricted shell on the same Mac can run `ssh` itself. The README lists Claude Code permission rules that close the obvious routes; they are not a sandbox.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include the version (`vm --version`), macOS version, and steps to reproduce, with real addresses removed. You should get a reply within a week.
