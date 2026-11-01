import { describe, expect, test } from "bun:test";
import { APP_LABEL, appLaunchArgs, appPlacement, launchAgentPlist, layout, mcpAddArgs } from "../src/surfaces/install.ts";
import { resolvePaths } from "../src/infra/paths.ts";

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

  describe("where the app goes", () => {
    const l = layout(resolvePaths({ HOME: "/Users/alex" }));

    test("an app from a download or a build is copied to ~/Applications, replacing the old copy", () => {
      expect(appPlacement("/tmp/x/VM Manager.app", l)).toEqual({
        target: "/Users/alex/Applications/VM Manager.app",
        inPlace: false,
        remove: ["/Users/alex/Applications/VM Manager.app"],
      });
    });

    test("an app Homebrew put in /Applications stays there, and an old ~/Applications copy goes", () => {
      expect(appPlacement("/Applications/VM Manager.app", l)).toEqual({
        target: "/Applications/VM Manager.app",
        inPlace: true,
        remove: ["/Users/alex/Applications/VM Manager.app"],
      });
    });

    test("an app already in ~/Applications stays and is not removed", () => {
      expect(appPlacement("/Users/alex/Applications/VM Manager.app", l)).toEqual({ target: "/Users/alex/Applications/VM Manager.app", inPlace: true, remove: [] });
    });
  });
});
