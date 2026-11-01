import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Vm } from "../domain/vm.ts";
import { expandHome, tildify } from "../infra/paths.ts";
import type { Context } from "./context.ts";
import { UserError } from "./errors.ts";
import { runCapped, sshArgs } from "./ssh.ts";

/** ssh-copy-id for a password server: the password comes from askpass, the key from `publicKey`. */
export function sshCopyIdArgs(vm: Vm, publicKey: string): string[] {
  return [
    "-i",
    publicKey,
    "-p",
    String(vm.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PreferredAuthentications=password,keyboard-interactive",
    "-o",
    "NumberOfPasswordPrompts=1",
    `${vm.user}@${vm.host}`,
  ];
}

/** Private keys in ~/.ssh that have a .pub next to them. */
export async function localKeys(sshDir: string): Promise<string[]> {
  const names = await readdir(sshDir).catch(() => [] as string[]);
  const keys: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".pub")).sort()) {
    const priv = join(sshDir, name.slice(0, -4));
    if (await stat(priv).then((s) => s.isFile(), () => false)) keys.push(priv);
  }
  return keys;
}

export interface KeySetupIo {
  out: (line: string) => void;
  spawn: (cmd: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

/**
 * Installs a public key on a password server with the stored password, checks that the key now
 * logs in, and only then switches the server to key login. The password stays in the Keychain.
 */
export async function keySetup(ctx: Context, vm: Vm, { key, generate }: { key: string; generate: boolean }, io: KeySetupIo): Promise<Vm> {
  if (vm.auth.kind !== "password") throw new UserError(`${vm.name} already logs in with a key (${vm.auth.identityFile}).`);
  if (!(await ctx.secrets.has(ctx.paths.keychainService, vm.name))) {
    throw new UserError(`Save the password for ${vm.name} first: \`vm password ${vm.name}\`.`);
  }
  const privateKey = expandHome(key, ctx.paths.home);
  const publicKey = `${privateKey}.pub`;
  const exists = await stat(publicKey).then(() => true, () => false);
  if (!exists) {
    if (!generate) throw new UserError(`${tildify(publicKey, ctx.paths.home)} does not exist. Pass --generate to create a new key there.`);
    io.out(`Creating ${tildify(privateKey, ctx.paths.home)} (ed25519, no passphrase).`);
    const code = await io.spawn(["/usr/bin/ssh-keygen", "-t", "ed25519", "-N", "", "-C", `vm-manager ${vm.name}`, "-f", privateKey], process.env);
    if (code !== 0) throw new UserError("ssh-keygen failed.");
  }

  io.out(`Copying ${tildify(publicKey, ctx.paths.home)} to ${vm.user}@${vm.host} with the saved password…`);
  const session = await ctx.sessions.open(vm.name);
  try {
    const code = await io.spawn(["/usr/bin/ssh-copy-id", ...sshCopyIdArgs(vm, publicKey)], { ...process.env, ...session.env });
    if (code !== 0) throw new UserError(`ssh-copy-id failed (exit ${code}). ${vm.name} still uses its password.`);
  } finally {
    await session.close();
  }

  const keyed: Vm = { ...vm, auth: { kind: "key", identityFile: tildify(privateKey, ctx.paths.home) } };
  io.out("Checking that the key logs in…");
  const check = await runCapped(["/usr/bin/ssh", ...sshArgs(keyed, { home: ctx.paths.home, command: "true" })], { timeoutMs: 20_000, maxBytes: 4000 });
  if (check.exitCode !== 0) throw new UserError(`The key was copied but logging in with it failed. ${vm.name} still uses its password.`);
  return ctx.inventory.put(keyed, { replacing: vm.name });
}
