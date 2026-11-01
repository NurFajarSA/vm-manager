import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Vm } from "../domain/vm.ts";
import type { Paths } from "../infra/paths.ts";

export const INCLUDE_LINE = "Include ~/.ssh/config.d/*.conf";

/** ~/.ssh/config.d/vm-manager.conf: one Host block per active server, named after it. */
export function renderSshConfig(vms: Vm[]): string {
  const lines = [
    "# Written by VM Manager (`vm sync-ssh`). Changes here are replaced on the next sync;",
    "# edit servers with `vm edit` or in the app instead.",
    "",
  ];
  for (const vm of vms.filter((v) => v.active)) {
    lines.push(`# ${vm.group} · ${vm.env}${vm.aliases.length ? ` · also ${vm.aliases.join(", ")}` : ""}`);
    if (vm.auth.kind === "password") lines.push(`# Password in the Keychain: \`vm ssh ${vm.name}\` signs in without asking.`);
    lines.push(`Host ${vm.name}`, `  HostName ${vm.host}`, `  User ${vm.user}`, `  Port ${vm.port}`);
    if (vm.auth.kind === "key") {
      const file = /\s/.test(vm.auth.identityFile) ? `"${vm.auth.identityFile}"` : vm.auth.identityFile;
      lines.push(`  IdentityFile ${file}`, "  IdentitiesOnly yes");
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** ~/.ssh/config with the Include as its first line. Returns null when it already is. */
export function withInclude(config: string | null): string | null {
  if (config === null) return `${INCLUDE_LINE}\n`;
  const first = config.split("\n", 1)[0]?.trim();
  if (first === INCLUDE_LINE) return null;
  return `${INCLUDE_LINE}\n\n${config}`;
}

export interface SyncReport {
  managedFile: string;
  hosts: string[];
  changed: boolean;
  includeAdded: boolean;
  backup: string | null;
}

/**
 * Writes the managed file, then makes sure ~/.ssh/config includes it first. The Include must come
 * before any Host block: an Include below one only applies inside that block. ~/.ssh/config is
 * backed up before it changes.
 */
export async function syncSshConfig(paths: Paths, vms: Vm[], { now = Date.now }: { now?: () => number } = {}): Promise<SyncReport> {
  await mkdir(paths.sshDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.sshManagedConfig), { recursive: true, mode: 0o700 });

  const rendered = renderSshConfig(vms);
  const before = await readFile(paths.sshManagedConfig, "utf8").catch(() => null);
  if (before !== rendered) await writeAtomic(paths.sshManagedConfig, rendered, 0o600);

  // A dotfiles setup often links ~/.ssh/config elsewhere; write through the link, not over it.
  const target = await realpath(paths.sshConfig).catch(() => paths.sshConfig);
  const config = await readFile(target, "utf8").catch(() => null);
  const next = withInclude(config);
  let backup: string | null = null;
  if (next !== null) {
    let mode = 0o600;
    if (config !== null) {
      mode = (await stat(target)).mode & 0o777;
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      backup = `${paths.sshConfig}.vm-manager-${stamp}.bak`;
      await copyFile(target, backup);
      await chmod(backup, 0o600);
    }
    await writeAtomic(target, next, mode);
  }
  return {
    managedFile: paths.sshManagedConfig,
    hosts: vms.filter((v) => v.active).map((v) => v.name),
    changed: before !== rendered,
    includeAdded: next !== null,
    backup,
  };
}

export async function sshConfigSynced(paths: Paths, vms: Vm[]): Promise<boolean> {
  const [managed, config] = await Promise.all([
    readFile(paths.sshManagedConfig, "utf8").catch(() => null),
    readFile(paths.sshConfig, "utf8").catch(() => null),
  ]);
  return managed === renderSshConfig(vms) && config !== null && withInclude(config) === null;
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}
