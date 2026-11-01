import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SecretStore } from "../infra/keychain.ts";

/**
 * Passwords reach ssh through SSH_ASKPASS, never through argv, env, files or the terminal.
 *
 * Each connection opens a session: a random nonce that goes to ssh in the environment, and a file
 * named after the nonce's SHA-256 that says which server it is for and when it expires. ssh starts
 * `vm askpass <name>`, which prints the Keychain item only when the nonce matches that server, the
 * session is still open, the process that started it is ssh, and the prompt asks for a password.
 * Listing the sessions folder shows hashes only, so seeing it is not enough to ask for a password.
 */

const SESSION_TTL_MS = 15 * 60_000;
const SessionSchema = z.object({ vm: z.string(), expiresAt: z.number() });

export const ASKPASS_ENV = { nonce: "VM_MANAGER_ASKPASS_NONCE", vm: "VM_MANAGER_ASKPASS_VM" } as const;

export interface AskpassSession {
  env: Record<string, string>;
  close(): Promise<void>;
}

const digest = (nonce: string) => createHash("sha256").update(nonce).digest("hex");

export class AskpassSessions {
  constructor(
    private readonly dir: string,
    private readonly selfCommand: string[],
    private readonly now: () => number = Date.now,
  ) {}

  get helperPath(): string {
    return join(this.dir, "vm-askpass");
  }

  async open(vmName: string): Promise<AskpassSession> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await this.writeHelper();
    const nonce = randomBytes(24).toString("hex");
    const file = join(this.dir, digest(nonce));
    await writeFile(file, JSON.stringify({ vm: vmName, expiresAt: this.now() + SESSION_TTL_MS }), { mode: 0o600 });
    return {
      env: {
        SSH_ASKPASS: this.helperPath,
        SSH_ASKPASS_REQUIRE: "force",
        [ASKPASS_ENV.nonce]: nonce,
        [ASKPASS_ENV.vm]: vmName,
      },
      close: () => rm(file, { force: true }),
    };
  }

  async verify(vmName: string, nonce: string | undefined): Promise<boolean> {
    if (!nonce || !/^[a-f0-9]{48}$/.test(nonce)) return false;
    try {
      const session = SessionSchema.parse(JSON.parse(await readFile(join(this.dir, digest(nonce)), "utf8")));
      return session.vm === vmName && session.expiresAt > this.now();
    } catch {
      return false;
    }
  }

  /** SSH_ASKPASS takes a program, not a command line, so a two-line script passes the server name on. */
  private async writeHelper(): Promise<void> {
    const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    const script = `#!/bin/sh\nexec ${this.selfCommand.map(quote).join(" ")} askpass "$${ASKPASS_ENV.vm}" "$1"\n`;
    const current = await readFile(this.helperPath, "utf8").catch(() => "");
    if (current !== script) await writeFile(this.helperPath, script, { mode: 0o700 });
    await chmod(this.helperPath, 0o700);
  }
}

/** The command that runs this CLI again: the compiled binary, or bun plus the script when run from source. */
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

export async function parentProcessName(): Promise<string> {
  const proc = Bun.spawn(["/bin/ps", "-o", "comm=", "-p", String(process.ppid)], { stdout: "pipe", stderr: "ignore" });
  const name = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return name.slice(name.lastIndexOf("/") + 1);
}

export interface AskpassRequest {
  vm: string;
  prompt: string | undefined;
  env: NodeJS.ProcessEnv;
  sessions: AskpassSessions;
  secrets: SecretStore;
  service: string;
  parentName: () => Promise<string>;
}

/** What `vm askpass` prints. Any failure prints nothing, so ssh gets an empty answer and gives up. */
export async function answerAskpass(req: AskpassRequest): Promise<{ ok: boolean; stdout: string; message: string }> {
  const refuse = (message: string) => ({ ok: false, stdout: "", message });
  if (!(await req.sessions.verify(req.vm, req.env[ASKPASS_ENV.nonce]))) {
    return refuse("vm askpass only answers ssh connections that VM Manager starts. Use `vm ssh <name>`.");
  }
  if ((await req.parentName()) !== "ssh") return refuse("vm askpass only answers ssh.");
  if (req.prompt !== undefined && (!/password/i.test(req.prompt) || /passphrase/i.test(req.prompt))) {
    return refuse("ssh asked something other than the server password; not answering.");
  }
  const secret = await req.secrets.get(req.service, req.vm);
  if (secret === null) return refuse(`No password saved for ${req.vm}. Run \`vm password ${req.vm}\`.`);
  return { ok: true, stdout: `${secret}\n`, message: "" };
}
