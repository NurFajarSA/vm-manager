import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INCLUDE_LINE, renderSshConfig, sshConfigSynced, syncSshConfig, withInclude } from "../src/core/sshconfig.ts";
import { exampleInventory } from "../src/domain/vm.ts";
import { resolvePaths } from "../src/infra/paths.ts";
import { tempDir, vm } from "./support.ts";

const vms = [
  vm({ name: "web-prod", host: "192.0.2.10", user: "deploy", auth: { kind: "key", identityFile: "~/.ssh/id_ed25519" }, aliases: ["shop.example.com"] }),
  vm({ name: "web-dev", env: "dev", host: "192.0.2.11", port: 2222, user: "dev", auth: { kind: "password" } }),
  vm({ name: "old-box", host: "198.51.100.9", active: false }),
  vm({ name: "spaced", host: "198.51.100.10", auth: { kind: "key", identityFile: "~/My Keys/id" } }),
];

describe("ssh config rendering", () => {
  test("one Host block per active server", () => {
    const text = renderSshConfig(vms);
    expect(text).toContain("Host web-prod\n  HostName 192.0.2.10\n  User deploy\n  Port 22\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n");
    expect(text).toContain("Host web-dev\n  HostName 192.0.2.11\n  User dev\n  Port 2222\n");
    expect(text).not.toContain("old-box");
    expect(text).toContain('IdentityFile "~/My Keys/id"');
    expect(text).toContain("# Web · prod · also shop.example.com");
  });

  test("password servers get no IdentityFile, and the comment points to vm ssh", () => {
    const block = renderSshConfig([vms[1]!]);
    expect(block).not.toContain("IdentityFile");
    expect(block).toContain("vm ssh web-dev");
  });

  test("the example renders, and every line is a comment, blank, Host or an indented option", () => {
    const text = renderSshConfig(exampleInventory().vms);
    for (const line of text.split("\n")) expect(line).toMatch(/^(#.*|Host [a-z0-9-]+|  [A-Za-z]+ .+|)$/);
    expect(text.match(/^Host /gm)).toHaveLength(7);
  });

  test("withInclude puts the Include first, once", () => {
    expect(withInclude(null)).toBe(`${INCLUDE_LINE}\n`);
    expect(withInclude("Host a\n  User b\n")).toBe(`${INCLUDE_LINE}\n\nHost a\n  User b\n`);
    expect(withInclude(`${INCLUDE_LINE}\nHost a\n`)).toBeNull();
  });
});

describe("sync-ssh (temp HOME only)", () => {
  async function home() {
    const dir = await tempDir();
    return { dir, paths: resolvePaths({ HOME: dir }) };
  }

  test("creates ~/.ssh, the managed file and a config with the Include", async () => {
    const { paths } = await home();
    const report = await syncSshConfig(paths, vms);
    expect(report).toMatchObject({ changed: true, includeAdded: true, backup: null, hosts: ["web-prod", "web-dev", "spaced"] });
    expect(await readFile(paths.sshConfig, "utf8")).toBe(`${INCLUDE_LINE}\n`);
    expect(await readFile(paths.sshManagedConfig, "utf8")).toBe(renderSshConfig(vms));
    expect((await stat(paths.sshManagedConfig)).mode & 0o777).toBe(0o600);
    expect((await stat(join(paths.sshDir, "config.d"))).mode & 0o777).toBe(0o700);
    expect(await sshConfigSynced(paths, vms)).toBe(true);
  });

  test("backs up an existing config, keeps its content and mode, and is idempotent", async () => {
    const { paths } = await home();
    await mkdir(paths.sshDir, { recursive: true });
    const original = "Host github.com\n  User git\n";
    await writeFile(paths.sshConfig, original, { mode: 0o644 });
    const first = await syncSshConfig(paths, vms, { now: () => Date.parse("2026-11-01T08:00:00Z") });
    expect(first.backup).toBe(`${paths.sshConfig}.vm-manager-2026-11-01T08-00-00-000Z.bak`);
    expect(await readFile(first.backup as string, "utf8")).toBe(original);
    expect(await readFile(paths.sshConfig, "utf8")).toBe(`${INCLUDE_LINE}\n\n${original}`);
    expect((await stat(paths.sshConfig)).mode & 0o777).toBe(0o644);

    const second = await syncSshConfig(paths, vms);
    expect(second).toMatchObject({ changed: false, includeAdded: false, backup: null });
    expect((await readdir(paths.sshDir)).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
  });

  test("an Include further down is not enough; it is added at the top", async () => {
    const { paths } = await home();
    await mkdir(paths.sshDir, { recursive: true });
    await writeFile(paths.sshConfig, `Host a\n  User b\n${INCLUDE_LINE}\n`);
    const report = await syncSshConfig(paths, vms);
    expect(report.includeAdded).toBe(true);
    expect((await readFile(paths.sshConfig, "utf8")).startsWith(`${INCLUDE_LINE}\n`)).toBe(true);
  });

  test("a symlinked config is edited through the link", async () => {
    const { dir, paths } = await home();
    await mkdir(paths.sshDir, { recursive: true });
    const real = join(dir, "dotfiles-ssh-config");
    await writeFile(real, "Host a\n");
    await symlink(real, paths.sshConfig);
    await syncSshConfig(paths, vms);
    expect((await lstat(paths.sshConfig)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe(`${INCLUDE_LINE}\n\nHost a\n`);
  });

  test("a changed inventory rewrites the managed file only", async () => {
    const { paths } = await home();
    await syncSshConfig(paths, vms);
    expect(await sshConfigSynced(paths, vms.slice(0, 1))).toBe(false);
    const report = await syncSshConfig(paths, vms.slice(0, 1));
    expect(report).toMatchObject({ changed: true, includeAdded: false });
    expect(await readFile(paths.sshManagedConfig, "utf8")).not.toContain("web-dev");
  });
});
