import type { Vm } from "../domain/vm.ts";
import { expandHome, tildify } from "../infra/paths.ts";
import type { AskpassSessions } from "./askpass.ts";
import { UserError } from "./errors.ts";
import { identityFile } from "./inventory.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const OUTPUT_CAP_BYTES = 200_000;

/**
 * ssh arguments for one server, built from the inventory rather than ~/.ssh/config so agents get
 * the same connection whether or not `vm sync-ssh` ran. Key servers run in BatchMode; password
 * servers use the askpass flow instead, because BatchMode would also switch askpass off.
 */
export function sshArgs(
  vm: Vm,
  { home, command, interactive = false, extra = [] }: { home: string; command?: string; interactive?: boolean; extra?: string[] },
): string[] {
  const args = [
    "-p",
    String(vm.port),
    "-l",
    vm.user,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (vm.auth.kind === "key") {
    args.push("-i", expandHome(vm.auth.identityFile, home), "-o", "IdentitiesOnly=yes");
    if (!interactive) args.push("-o", "BatchMode=yes");
  } else {
    args.push(
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  if (!interactive) args.push("-T");
  args.push(...extra, "--", vm.host);
  if (command !== undefined) args.push(command);
  return args;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface Runner {
  run(vm: Vm, command: string, options?: RunOptions): Promise<RunResult>;
}

export interface SshRunnerOptions {
  home: string;
  sessions: AskpassSessions;
  ssh?: string;
  now?: () => number;
}

export class SshRunner implements Runner {
  constructor(private readonly options: SshRunnerOptions) {}

  async run(vm: Vm, command: string, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = OUTPUT_CAP_BYTES }: RunOptions = {}): Promise<RunResult> {
    await assertKeyPresent(vm, this.options.home);
    const session = vm.auth.kind === "password" ? await this.options.sessions.open(vm.name) : null;
    try {
      return await runCapped([this.options.ssh ?? "/usr/bin/ssh", ...sshArgs(vm, { home: this.options.home, command })], {
        env: { ...process.env, ...(session?.env ?? {}) },
        timeoutMs: Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS),
        maxBytes,
        now: this.options.now,
      });
    } finally {
      await session?.close();
    }
  }
}

export async function assertKeyPresent(vm: Vm, home: string): Promise<void> {
  const key = await identityFile(vm, home);
  if (key && !key.exists) {
    throw new UserError(`The key file for ${vm.name}, ${tildify(key.path, home)}, is missing. Add the key or change the server's login in VM Manager.`);
  }
}

/** Runs a process, keeps at most `maxBytes` of stdout and stderr together, and kills it at the deadline. */
export async function runCapped(
  cmd: string[],
  { env, timeoutMs, maxBytes, now = Date.now }: { env?: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number; now?: () => number },
): Promise<RunResult> {
  const started = now();
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let kept = 0;
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
  }, timeoutMs);

  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const collect = async (reader: (typeof readers)[number]) => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      const room = maxBytes - kept;
      if (room > 0) {
        const piece = value.byteLength <= room ? value : value.subarray(0, room);
        chunks.push(piece);
        kept += piece.byteLength;
      }
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };

  const collected = Promise.all(readers.map(collect));
  const code = await proc.exited;
  // A child the command left behind can hold the pipes open; stop reading shortly after exit.
  await Promise.race([collected, Bun.sleep(1000)]);
  for (const reader of readers) reader.cancel().catch(() => {});
  const [stdout = "", stderr = ""] = await collected;
  clearTimeout(timer);
  return {
    exitCode: timedOut ? null : code,
    stdout,
    stderr,
    outputBytes: total,
    truncated: total > kept,
    timedOut,
    durationMs: now() - started,
  };
}

/** `vm ssh <name>`: a normal interactive session, with the password coming from the Keychain. */
export async function interactiveSsh(vm: Vm, { home, sessions, extra = [], ssh = "/usr/bin/ssh" }: { home: string; sessions: AskpassSessions; extra?: string[]; ssh?: string }): Promise<number> {
  await assertKeyPresent(vm, home);
  const session = vm.auth.kind === "password" ? await sessions.open(vm.name) : null;
  try {
    const proc = Bun.spawn([ssh, ...sshArgs(vm, { home, interactive: true, extra })], {
      env: { ...process.env, ...(session?.env ?? {}) },
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  } finally {
    await session?.close();
  }
}
