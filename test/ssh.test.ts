import { describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { answerAskpass, ASKPASS_ENV, AskpassSessions } from "../src/core/askpass.ts";
import { sshCopyIdArgs } from "../src/core/keysetup.ts";
import { runCapped, SshRunner, sshArgs } from "../src/core/ssh.ts";
import { MemorySecretStore } from "../src/infra/keychain.ts";
import { tempDir, vm } from "./support.ts";

const PASSWORD = "correct horse battery staple";
const home = "/Users/alex";

describe("ssh arguments", () => {
  test("key servers use the key only, in BatchMode, with the host after --", () => {
    const args = sshArgs(vm({ auth: { kind: "key", identityFile: "~/.ssh/id_ed25519" }, port: 2222 }), { home, command: "uptime" });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", "/Users/alex/.ssh/id_ed25519"]);
    expect(args.slice(0, 4)).toEqual(["-p", "2222", "-l", "deploy"]);
    expect(args.slice(-3)).toEqual(["--", "192.0.2.10", "uptime"]);
    expect(args).toContain("-T");
  });

  test("password servers skip keys and BatchMode, so askpass is used", () => {
    const args = sshArgs(vm(), { home, command: "uptime" });
    expect(args).not.toContain("BatchMode=yes");
    expect(args).toContain("PubkeyAuthentication=no");
    expect(args).toContain("NumberOfPasswordPrompts=1");
    expect(args.join(" ")).not.toContain(PASSWORD);
  });

  test("interactive sessions get a terminal and allow key passphrase prompts", () => {
    const args = sshArgs(vm({ auth: { kind: "key", identityFile: "~/.ssh/k" } }), { home, interactive: true, extra: ["-L", "8080:localhost:80"] });
    expect(args).not.toContain("BatchMode=yes");
    expect(args).not.toContain("-T");
    expect(args.slice(-4)).toEqual(["-L", "8080:localhost:80", "--", "192.0.2.10"]);
  });

  test("ssh-copy-id uses the password flow and the public key", () => {
    const args = sshCopyIdArgs(vm({ port: 2200 }), "/Users/alex/.ssh/id_ed25519.pub");
    expect(args.slice(0, 4)).toEqual(["-i", "/Users/alex/.ssh/id_ed25519.pub", "-p", "2200"]);
    expect(args.at(-1)).toBe("deploy@192.0.2.10");
    expect(args).toContain("PubkeyAuthentication=no");
  });
});

/** A stand-in for /usr/bin/ssh that prints everything it was given: argv and environment. */
async function fakeSsh(dir: string, body = 'printf "%s\\n" "$@"; env'): Promise<string> {
  const path = join(dir, "ssh");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("askpass", () => {
  async function setup() {
    const dir = await tempDir();
    const sessions = new AskpassSessions(join(dir, "askpass"), ["/usr/local/bin/vm"]);
    const secrets = new MemorySecretStore();
    await secrets.set("vm-manager", "web-prod", PASSWORD);
    return { dir, sessions, secrets };
  }

  const ask = (s: Awaited<ReturnType<typeof setup>>, env: NodeJS.ProcessEnv, overrides: Partial<Parameters<typeof answerAskpass>[0]> = {}) =>
    answerAskpass({ vm: "web-prod", prompt: "deploy@192.0.2.10's password: ", env, sessions: s.sessions, secrets: s.secrets, service: "vm-manager", parentName: async () => "ssh", ...overrides });

  test("answers ssh inside an open session", async () => {
    const s = await setup();
    const session = await s.sessions.open("web-prod");
    expect(await ask(s, session.env)).toEqual({ ok: true, stdout: `${PASSWORD}\n`, message: "" });
    expect(session.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(session.env.SSH_ASKPASS).toBe(s.sessions.helperPath);
  });

  test("refuses without a session, with a guessed nonce, or after the session closed", async () => {
    const s = await setup();
    expect((await ask(s, {})).ok).toBe(false);
    expect((await ask(s, { [ASKPASS_ENV.nonce]: "0".repeat(48) })).ok).toBe(false);
    const session = await s.sessions.open("web-prod");
    await session.close();
    const result = await ask(s, session.env);
    expect(result).toEqual({ ok: false, stdout: "", message: expect.stringContaining("only answers ssh connections") });
  });

  test("refuses another server's password with this server's session", async () => {
    const s = await setup();
    await s.secrets.set("vm-manager", "db-prod", "other-secret");
    const session = await s.sessions.open("web-prod");
    const result = await ask(s, session.env, { vm: "db-prod" });
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe("");
  });

  test("refuses when the caller is not ssh, e.g. an agent running `vm askpass` in a shell", async () => {
    const s = await setup();
    const session = await s.sessions.open("web-prod");
    for (const parent of ["zsh", "bash", "node", "claude"]) {
      const result = await ask(s, session.env, { parentName: async () => parent });
      expect(result).toEqual({ ok: false, stdout: "", message: "vm askpass only answers ssh." });
    }
  });

  test("refuses prompts that are not a password prompt", async () => {
    const s = await setup();
    const session = await s.sessions.open("web-prod");
    for (const prompt of ["Are you sure you want to continue connecting (yes/no/[fingerprint])?", "Enter passphrase for key '/x':", "Verification code:"]) {
      expect((await ask(s, session.env, { prompt })).ok).toBe(false);
    }
  });

  test("expired sessions don't answer", async () => {
    const dir = await tempDir();
    let now = 1_000_000;
    const sessions = new AskpassSessions(join(dir, "askpass"), ["/x"], () => now);
    const secrets = new MemorySecretStore();
    await secrets.set("vm-manager", "web-prod", PASSWORD);
    const session = await sessions.open("web-prod");
    now += 16 * 60_000;
    const result = await answerAskpass({ vm: "web-prod", prompt: undefined, env: session.env, sessions, secrets, service: "vm-manager", parentName: async () => "ssh" });
    expect(result.ok).toBe(false);
  });

  test("the sessions folder holds hashes only, never the nonce or the password", async () => {
    const s = await setup();
    const session = await s.sessions.open("web-prod");
    const dir = join(s.dir, "askpass");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const files = await readdir(dir);
    const nonce = session.env[ASKPASS_ENV.nonce] as string;
    for (const file of files) {
      expect(file).not.toContain(nonce);
      const text = await readFile(join(dir, file), "utf8");
      expect(text).not.toContain(nonce);
      expect(text).not.toContain(PASSWORD);
    }
    expect((await stat(s.sessions.helperPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(s.sessions.helperPath, "utf8")).toBe(`#!/bin/sh\nexec '/usr/local/bin/vm' askpass "$VM_MANAGER_ASKPASS_VM" "$1"\n`);
  });

  test("a full run never puts the password in argv, env, output or files", async () => {
    const s = await setup();
    const ssh = await fakeSsh(s.dir);
    const runner = new SshRunner({ home: s.dir, sessions: s.sessions, ssh });
    const result = await runner.run(vm(), "uptime");
    expect(result.exitCode).toBe(0);
    const seen = result.stdout + result.stderr;
    expect(seen).toContain("SSH_ASKPASS_REQUIRE=force");
    expect(seen).toContain("VM_MANAGER_ASKPASS_VM=web-prod");
    expect(seen).not.toContain(PASSWORD);
    // The session closes with the connection.
    expect((await readdir(join(s.dir, "askpass"))).filter((f) => /^[a-f0-9]{64}$/.test(f))).toHaveLength(0);
  });

  test("key servers get no askpass session at all", async () => {
    const s = await setup();
    await writeFile(join(s.dir, "id_test"), "not a real key");
    const ssh = await fakeSsh(s.dir);
    const runner = new SshRunner({ home: s.dir, sessions: s.sessions, ssh });
    const result = await runner.run(vm({ auth: { kind: "key", identityFile: "~/id_test" } }), "uptime");
    expect(result.stdout).not.toContain("SSH_ASKPASS");
    expect(result.stdout).toContain("BatchMode=yes");
  });

  test("a missing key file stops before ssh runs", async () => {
    const s = await setup();
    const runner = new SshRunner({ home: s.dir, sessions: s.sessions, ssh: "/usr/bin/false" });
    await expect(runner.run(vm({ auth: { kind: "key", identityFile: "~/.ssh/payments_ed25519" } }), "uptime")).rejects.toThrow("~/.ssh/payments_ed25519, is missing");
  });
});

describe("runCapped", () => {
  test("keeps the first 200 KB and counts the rest", async () => {
    const result = await runCapped(["/bin/sh", "-c", "head -c 500000 /dev/zero | tr '\\0' a"], { timeoutMs: 10_000, maxBytes: 200_000 });
    expect(result.stdout.length).toBe(200_000);
    expect(result.outputBytes).toBe(500_000);
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("stops a command at the deadline", async () => {
    const result = await runCapped(["/bin/sh", "-c", "echo started; sleep 10"], { timeoutMs: 300, maxBytes: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("started\n");
    expect(result.durationMs).toBeLessThan(5000);
  });

  test("passes the exit code and stderr through", async () => {
    const result = await runCapped(["/bin/sh", "-c", "echo oops >&2; exit 3"], { timeoutMs: 5000, maxBytes: 1000 });
    expect(result).toMatchObject({ exitCode: 3, stderr: "oops\n", truncated: false, timedOut: false });
  });
});
