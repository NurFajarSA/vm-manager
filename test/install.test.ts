import { describe, expect, test } from "bun:test";
import { APP_LABEL, appLaunchArgs, launchAgentPlist, mcpAddArgs } from "../src/surfaces/install.ts";

describe("install", () => {
  test("the login item opens the app with --at-login, so the server picker stays hidden at login", () => {
    const app = "/Users/alex/Applications/VM Manager.app";
    expect(appLaunchArgs(app)).toEqual(["/usr/bin/open", "-a", app, "--args", "--at-login"]);
    const plist = launchAgentPlist(APP_LABEL, appLaunchArgs(app), "/Users/alex/.config/vm-manager/vm-manager.log");
    expect(plist).toContain("<string>--args</string><string>--at-login</string>");
    expect(plist).toContain(`<key>Label</key><string>${APP_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key><false/>");
  });

  test("the MCP server is registered in user scope and runs `vm mcp`", () => {
    expect(mcpAddArgs("/Users/alex/.local/bin/vm")).toEqual(["mcp", "add", "--scope", "user", "vm-manager", "--", "/Users/alex/.local/bin/vm", "mcp"]);
  });
});
