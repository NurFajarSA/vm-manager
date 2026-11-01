# Contributing

## Setup

```bash
bun install
bun run check          # typecheck + tests
bun src/cli.ts list    # run the CLI from source
./macos/build-app.sh   # build the menu bar app into dist/
```

Requirements: macOS 15+, Bun 1.3+, Xcode command line tools.

## Before opening a pull request

- `bun run check` passes, and `swift build --package-path macos` builds.
- Behaviour changes come with a test that calls the code the way a user would and checks literal results (see `test/mcp.test.ts`).
- Tests never touch the real `~/.ssh`, the Keychain or a server: use `testContext()` from `test/support.ts`, a temp `HOME` and the fake runner.
- Never put real hostnames, addresses, user names or key file names in code, tests, fixtures or screenshots. Use the documentation ranges `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`, and `example.com`.
- Anything that widens what counts as read-only, or narrows the blocklist, needs a test for the commands it lets through and the ones it still stops.
- Never log or print a password. The audit log stores commands, not output.
- UI copy is English. Buttons and menu items use title-style capitalization; descriptions use sentence case.

After a UI change, rebuild the app and run `scripts/screenshots.sh` to refresh `docs/images`.
