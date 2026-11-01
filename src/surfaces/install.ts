import { copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Paths } from "../infra/paths.ts";

export const APP_LABEL = "app.vm-manager.menubar";
export const APP_NAME = "VM Manager.app";
export const MCP_NAME = "vm-manager";
const SYSTEM_APP_DIR = "/Applications";

export interface InstallLayout {
  bin: string;
  appDir: string;
  launchAgents: string;
}

export function layout(paths: Paths): InstallLayout {
  return {
    bin: join(paths.home, ".local", "bin", "vm"),
    appDir: join(paths.home, "Applications"),
    launchAgents: join(paths.home, "Library", "LaunchAgents"),
  };
}

export type Step = { name: string; ok: boolean; detail: string };

/**
 * How the login item starts the app. `--at-login` tells the app it was started by launchd, so it stays in the
 * menu bar instead of opening the server picker; opening it from the Dock, Finder or Spotlight shows the picker.
 */
export function appLaunchArgs(app: string): string[] {
  return ["/usr/bin/open", "-a", app, "--args", "--at-login"];
}

/** The exact `claude mcp add` arguments `vm install` uses, kept here so the README and tests agree. */
export function mcpAddArgs(bin: string): string[] {
  return ["mcp", "add", "--scope", "user", MCP_NAME, "--", bin, "mcp"];
}

export async function install({ paths, sourceBinary, app }: { paths: Paths; sourceBinary: string; app?: string }): Promise<Step[]> {
  const l = layout(paths);
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await step("binary", async () => {
    await mkdir(dirname(l.bin), { recursive: true });
    if (sourceBinary !== l.bin) {
      await rm(l.bin, { force: true });
      await copyFile(sourceBinary, l.bin);
    }
    await sh(["/bin/chmod", "755", l.bin]);
    await unquarantine(l.bin);
    return l.bin;
  });

  await step("MCP server for Claude", async () => {
    const claude = Bun.which("claude") ?? "/opt/homebrew/bin/claude";
    await sh([claude, "mcp", "remove", "--scope", "user", MCP_NAME], { allowFailure: true });
    await sh([claude, ...mcpAddArgs(l.bin)]);
    return `user-scope MCP "${MCP_NAME}"`;
  });

  if (app) {
    await step("menu bar app", async () => {
      await mkdir(l.appDir, { recursive: true });
      const source = resolve(app);
      const inPlace = [l.appDir, SYSTEM_APP_DIR].includes(dirname(source));
      const target = inPlace ? source : join(l.appDir, basename(app));
      if (!inPlace) {
        await removeApp(target);
        await cp(app, target, { recursive: true });
      }
      await unquarantine(target);
      const plist = join(l.launchAgents, `${APP_LABEL}.plist`);
      await writeLaunchAgent(plist, APP_LABEL, appLaunchArgs(target), paths.logFile);
      await reloadAgent(plist, APP_LABEL);
      return `${target} (opens at login)`;
    });
  }
  return steps;
}

export async function uninstall({ paths }: { paths: Paths }): Promise<Step[]> {
  const l = layout(paths);
  const steps: Step[] = [];
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ name, ok: true, detail: "removed" });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  await attempt("MCP server for Claude", async () => {
    const claude = Bun.which("claude") ?? "/opt/homebrew/bin/claude";
    await sh([claude, "mcp", "remove", "--scope", "user", MCP_NAME], { allowFailure: true });
  });
  await attempt(`launchd ${APP_LABEL}`, async () => {
    await sh(["/bin/launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${APP_LABEL}`], { allowFailure: true });
    await rm(join(l.launchAgents, `${APP_LABEL}.plist`), { force: true });
  });
  await attempt("menu bar app", () => removeApp(join(l.appDir, APP_NAME)));
  await attempt("binary", () => rm(l.bin, { force: true }));
  return steps;
}

export async function setLoginItem({ paths, enabled }: { paths: Paths; enabled: boolean }): Promise<boolean> {
  const l = layout(paths);
  const plist = join(l.launchAgents, `${APP_LABEL}.plist`);
  if (enabled) {
    const app = await installedApp(l);
    if (!app) throw new Error(`${APP_NAME} is not installed in ${l.appDir} or ${SYSTEM_APP_DIR}`);
    await writeLaunchAgent(plist, APP_LABEL, appLaunchArgs(app), paths.logFile);
  } else {
    await sh(["/bin/launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${APP_LABEL}`], { allowFailure: true });
    await rm(plist, { force: true });
  }
  return loginItemEnabled(paths);
}

export async function loginItemEnabled(paths: Paths): Promise<boolean> {
  return exists(join(layout(paths).launchAgents, `${APP_LABEL}.plist`));
}

// A build without a Developer ID keeps the quarantine flag through the copy, and Gatekeeper then
// kills the binary without a prompt. Running install is the consent.
async function unquarantine(path: string): Promise<void> {
  await sh(["/usr/bin/xattr", "-dr", "com.apple.quarantine", path], { allowFailure: true });
}

async function installedApp(l: InstallLayout): Promise<string | null> {
  for (const dir of [l.appDir, SYSTEM_APP_DIR]) if (await exists(join(dir, APP_NAME))) return join(dir, APP_NAME);
  return null;
}

async function removeApp(app: string): Promise<void> {
  await sh(["/usr/bin/pkill", "-f", `${app}/Contents/MacOS/`], { allowFailure: true });
  await rm(app, { recursive: true, force: true });
}

export function launchAgentPlist(label: string, args: string[], log: string): string {
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

async function writeLaunchAgent(path: string, label: string, args: string[], log: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, launchAgentPlist(label, args, log), { mode: 0o644 });
}

async function reloadAgent(plist: string, label: string) {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await sh(["/bin/launchctl", "bootout", `${domain}/${label}`], { allowFailure: true });
  // bootout returns before the old job is gone, and bootstrapping over it fails with error 5.
  for (let i = 0; i < 50 && (await loaded(domain, label)); i++) await Bun.sleep(100);
  try {
    await sh(["/bin/launchctl", "bootstrap", domain, plist]);
  } catch {
    await Bun.sleep(1000);
    await sh(["/bin/launchctl", "bootstrap", domain, plist]);
  }
}

async function loaded(domain: string, label: string): Promise<boolean> {
  const proc = Bun.spawn(["/bin/launchctl", "print", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function sh(cmd: string[], { allowFailure = false } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !allowFailure) throw new Error(`${basename(cmd[0] ?? "")} ${cmd.slice(1, 3).join(" ")} failed: ${(stderr || stdout).trim()}`);
  return stdout;
}
