import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { AuditLog, redact } from "../src/core/audit.ts";
import { UserError } from "../src/core/errors.ts";
import type { Runner } from "../src/core/ssh.ts";
import { describeOutcome, settle } from "../src/core/supervisor.ts";
import { FakeClock, FakeRunner, tempDir, testContext, vm } from "./support.ts";

/** Approves (or denies) the first request that shows up, the way the app would. */
function decideWhenAsked(ctx: Awaited<ReturnType<typeof testContext>>, status: "approved" | "denied") {
  const realSleep = ctx.clock.sleep.bind(ctx.clock);
  ctx.clock.sleep = async (ms) => {
    const [pending] = await ctx.approvals.pending();
    if (pending) await settle(ctx, pending.id, status, "app");
    await realSleep(ms);
  };
}

describe("supervisor", () => {
  test("a read-only command runs and is audited without its output", async () => {
    const runner = new FakeRunner({ stdout: "SECRET-LOOKING OUTPUT\n", outputBytes: 22 });
    const ctx = await testContext({ runner });
    const outcome = await ctx.supervisor.execute({ vm: vm(), command: "df -h", tool: "read", requester: "agent" });
    expect(outcome.status).toBe("ran");
    expect(runner.calls).toEqual([{ vm: "web-prod", command: "df -h", options: undefined }]);
    const [entry] = await ctx.audit.read();
    expect(entry).toMatchObject({ kind: "read", vm: "web-prod", command: "df -h", decision: "allowed", exitCode: 0, outputBytes: 22, durationMs: 12 });
    expect(await readFile(ctx.paths.auditFile, "utf8")).not.toContain("SECRET-LOOKING");
  });

  test("vm_read refuses a change and nothing runs", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    const outcome = await ctx.supervisor.execute({ vm: vm(), command: "systemctl restart nginx", tool: "read", requester: "agent" });
    expect(outcome.status).toBe("refused");
    expect(describeOutcome(outcome)).toContain("Use vm_change");
    expect(runner.calls).toHaveLength(0);
    expect((await ctx.audit.read())[0]?.decision).toBe("refused");
  });

  test("a change on a free server runs straight away", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    const outcome = await ctx.supervisor.execute({ vm: vm({ agent: "free", env: "dev" }), command: "docker compose up -d", tool: "change", requester: "agent" });
    expect(outcome.status).toBe("ran");
    expect(await ctx.approvals.list()).toHaveLength(0);
  });

  test("a change on an approve server waits, then runs once approved", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    decideWhenAsked(ctx, "approved");
    const pending: string[] = [];
    const outcome = await ctx.supervisor.execute({
      vm: vm(),
      command: "systemctl restart nginx",
      tool: "change",
      requester: "claude-code in shop",
      why: "reload config",
      onPending: (a) => {
        pending.push(a.id);
      },
    });
    expect(outcome.status).toBe("ran");
    expect(pending).toHaveLength(1);
    expect(runner.calls.map((c) => c.command)).toEqual(["systemctl restart nginx"]);
    const approval = await ctx.approvals.get(pending[0] as string);
    expect(approval).toMatchObject({ status: "approved", decidedBy: "app", why: "reload config", requester: "claude-code in shop" });
    expect((await ctx.audit.read()).map((e) => `${e.kind}:${e.decision}`)).toEqual(["change:requested", "approval:approved", "change:approved"]);
  });

  test("a denied change never runs", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    decideWhenAsked(ctx, "denied");
    const outcome = await ctx.supervisor.execute({ vm: vm(), command: "rm -rf /srv/app/cache", tool: "change", requester: "agent" });
    expect(outcome.status).toBe("denied");
    expect(describeOutcome(outcome)).toContain("Do not retry");
    expect(runner.calls).toHaveLength(0);
    expect((await ctx.audit.read()).map((e) => e.decision)).toEqual(["requested", "denied", "denied"]);
  });

  test("an unanswered change expires after 10 minutes", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    const started = ctx.clock.now();
    const outcome = await ctx.supervisor.execute({ vm: vm(), command: "apt-get upgrade -y", tool: "change", requester: "agent" });
    expect(outcome.status).toBe("expired");
    expect(ctx.clock.now() - started).toBeGreaterThanOrEqual(10 * 60_000);
    expect(runner.calls).toHaveLength(0);
  });

  test("no agent access refuses everything", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    for (const tool of ["read", "change"] as const) {
      const outcome = await ctx.supervisor.execute({ vm: vm({ agent: "none" }), command: "uptime", tool, requester: "agent" });
      expect(outcome.status).toBe("refused");
    }
    expect(runner.calls).toHaveLength(0);
  });

  test("inactive servers are refused", async () => {
    const ctx = await testContext();
    const outcome = await ctx.supervisor.execute({ vm: vm({ active: false, agent: "free" }), command: "uptime", tool: "read", requester: "agent" });
    expect(outcome.status).toBe("refused");
  });

  test("the hard blocklist is refused without ever asking", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    for (const command of ["sudo reboot", "cat x; rm -rf /", "echo $(shutdown -h now)"]) {
      const outcome = await ctx.supervisor.execute({ vm: vm({ agent: "free" }), command, tool: "change", requester: "agent", confirmDestructive: true });
      expect(outcome.status).toBe("refused");
    }
    expect(await ctx.approvals.list()).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  test("DROP DATABASE needs confirm_destructive, then approval even on a free server", async () => {
    const runner = new FakeRunner();
    const ctx = await testContext({ runner });
    const free = vm({ agent: "free", env: "dev" });
    const command = `psql -c "DROP DATABASE shop"`;
    expect((await ctx.supervisor.execute({ vm: free, command, tool: "change", requester: "agent" })).status).toBe("refused");
    decideWhenAsked(ctx, "approved");
    const outcome = await ctx.supervisor.execute({ vm: free, command, tool: "change", requester: "agent", confirmDestructive: true });
    expect(outcome.status).toBe("ran");
    expect(outcome.status === "ran" && outcome.approval?.status).toBe("approved");
  });

  test("an ssh failure is reported and audited, not thrown", async () => {
    const failing: Runner = {
      run: async () => {
        throw new UserError("The key file for web-prod, ~/.ssh/missing, is missing.");
      },
    };
    const ctx = await testContext({ runner: failing });
    const outcome = await ctx.supervisor.execute({ vm: vm(), command: "uptime", tool: "read", requester: "agent" });
    expect(outcome.status === "refused" && outcome.reason).toContain("is missing");
    expect((await ctx.audit.read())[0]?.decision).toBe("refused");
  });

  test("the output an agent gets says when it was cut or timed out", () => {
    const text = describeOutcome({
      status: "ran",
      vm: "web-prod",
      approval: null,
      result: { exitCode: null, stdout: "a".repeat(10), stderr: "", outputBytes: 500_000, truncated: true, timedOut: true, durationMs: 120_000 },
    });
    expect(text).toContain("timed out");
    expect(text).toContain("output cut");
  });
});

describe("audit log", () => {
  test("writes one private JSON line per entry, in order, even when calls overlap", async () => {
    const path = `${await tempDir()}/audit.jsonl`;
    const clock = new FakeClock();
    const log = new AuditLog(path, () => clock.now());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.record({ kind: "read", vm: "web-prod", command: `tail -n ${i} app.log`, requester: "agent", decision: "allowed", exitCode: 0, durationMs: 5, outputBytes: i }),
      ),
    );
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.map((l) => JSON.parse(l).outputBytes)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const [first] = await log.read({ limit: 1 });
    expect(Object.keys(first ?? {}).sort()).toEqual(["approvalId", "command", "decision", "durationMs", "exitCode", "kind", "outputBytes", "reason", "requester", "ts", "vm"]);
  });

  test("read skips torn lines and filters by server", async () => {
    const path = `${await tempDir()}/audit.jsonl`;
    const log = new AuditLog(path);
    await log.record({ kind: "read", vm: "a", command: "uptime", requester: "x", decision: "allowed" });
    await Bun.write(path, `${await readFile(path, "utf8")}{"ts": "broken\n`);
    const other = new AuditLog(path);
    await other.record({ kind: "change", vm: "b", command: "uptime", requester: "x", decision: "refused" });
    expect((await other.read()).map((e) => e.vm)).toEqual(["a", "b"]);
    expect((await other.read({ vm: "b" })).map((e) => e.vm)).toEqual(["b"]);
  });

  test.each([
    ["mysql -u root -phunter2 -e 'select 1'", "hunter2", "-p***"],
    ["PGPASSWORD=hunter2 psql -h db", "hunter2", "PGPASSWORD=***"],
    ["curl -H 'Authorization: Bearer abc.def.ghi' https://x", "abc.def.ghi", "Bearer ***"],
    ["git clone https://bot:ghp_secret@github.com/org/repo", "ghp_secret", "bot:***@"],
    ["deploy --token=tok123 --env prod", "tok123", "--token ***"],
    ["export API_KEY=sk-123", "sk-123", "API_KEY=***"],
  ])("redacts credentials in %s", (command, secret, shown) => {
    const text = redact(command);
    expect(text).not.toContain(secret);
    expect(text).toContain(shown);
  });

  test("leaves ordinary commands alone", () => {
    expect(redact("mkdir -p /srv/app && docker compose up -d")).toBe("mkdir -p /srv/app && docker compose up -d");
  });
});
