import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AskpassSessions } from "../src/core/askpass.ts";
import { runCapped } from "../src/core/ssh.ts";
import { MacKeychain } from "../src/infra/keychain.ts";
import { tempDir } from "./support.ts";

// The whole askpass chain with real processes: a stand-in `ssh` binary starts SSH_ASKPASS the way
// ssh does, the helper script runs `vm askpass`, and that reads a throwaway item from the real
// login Keychain. Set CI_NO_KEYCHAIN=1 to skip it.
const skip = process.platform !== "darwin" || Boolean(process.env.CI_NO_KEYCHAIN) || !Bun.which("cc");

const FAKE_SSH = `
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
int main(void) {
  const char *askpass = getenv("SSH_ASKPASS");
  if (!askpass) return 2;
  int fds[2];
  pipe(fds);
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, fds[1], 1);
  posix_spawn_file_actions_addclose(&actions, fds[0]);
  char *argv[] = {(char *)askpass, "deploy@192.0.2.10's password: ", NULL};
  pid_t pid;
  if (posix_spawn(&pid, askpass, &actions, NULL, argv, environ) != 0) return 3;
  close(fds[1]);
  char buf[4096];
  ssize_t n;
  while ((n = read(fds[0], buf, sizeof buf)) > 0) fwrite(buf, 1, n, stdout);
  int status;
  waitpid(pid, &status, 0);
  return WEXITSTATUS(status);
}
`;

const service = `vm-manager-e2e-${randomBytes(4).toString("hex")}`;
const keychain = new MacKeychain();
const PASSWORD = `fake-${randomBytes(6).toString("hex")}`;

describe.skipIf(skip)("askpass end to end (real Keychain, throwaway item)", () => {
  afterAll(async () => {
    await keychain.delete(service, "web-prod");
  });

  async function setup() {
    const dir = await tempDir();
    const source = join(dir, "fake-ssh.c");
    const ssh = join(dir, "ssh");
    await writeFile(source, FAKE_SSH);
    const cc = Bun.spawnSync(["cc", "-o", ssh, source]);
    if (cc.exitCode !== 0) throw new Error(cc.stderr.toString());
    const state = join(dir, "state");
    const sessions = new AskpassSessions(join(state, "askpass"), [process.execPath, resolve(import.meta.dir, "../src/cli.ts")]);
    await keychain.set(service, "web-prod", PASSWORD);
    // HOME stays real: security finds the login Keychain through it.
    const env = { ...process.env, VM_MANAGER_HOME: state, VM_MANAGER_KEYCHAIN_SERVICE: service };
    return { ssh, sessions, env };
  }

  test("ssh gets the password through an open session", async () => {
    const { ssh, sessions, env } = await setup();
    const session = await sessions.open("web-prod");
    try {
      const result = await runCapped([ssh], { env: { ...env, ...session.env }, timeoutMs: 20_000, maxBytes: 4096 });
      expect(result.stdout).toBe(`${PASSWORD}\n`);
      expect(result.exitCode).toBe(0);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("without a session, or once it is closed, nothing is printed", async () => {
    const { ssh, sessions, env } = await setup();
    const session = await sessions.open("web-prod");
    await session.close();
    const closed = await runCapped([ssh], { env: { ...env, ...session.env }, timeoutMs: 20_000, maxBytes: 4096 });
    expect(closed.stdout).toBe("");
    expect(closed.exitCode).toBe(1);

    const forged = await runCapped([ssh], { env: { ...env, SSH_ASKPASS: sessions.helperPath, VM_MANAGER_ASKPASS_VM: "web-prod" }, timeoutMs: 20_000, maxBytes: 4096 });
    expect(forged.stdout).toBe("");
    expect(forged.stderr).not.toContain(PASSWORD);
  }, 30_000);

  test("running vm askpass directly, as an agent's shell would, prints nothing", async () => {
    const { sessions, env } = await setup();
    const session = await sessions.open("web-prod");
    try {
      const direct = await runCapped([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "askpass", "web-prod", "password:"], {
        env: { ...env, ...session.env },
        timeoutMs: 20_000,
        maxBytes: 4096,
      });
      expect(direct.stdout).toBe("");
      expect(direct.stderr).toContain("only answers ssh");
      expect(direct.stderr).not.toContain(PASSWORD);
    } finally {
      await session.close();
    }
  }, 30_000);
});
