import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, type Clock } from "../src/core/approvals.ts";
import { AskpassSessions } from "../src/core/askpass.ts";
import { AuditLog } from "../src/core/audit.ts";
import type { Context } from "../src/core/context.ts";
import { InventoryStore } from "../src/core/inventory.ts";
import type { Runner, RunOptions, RunResult } from "../src/core/ssh.ts";
import { Supervisor } from "../src/core/supervisor.ts";
import { parseVm, type Vm, type VmInput } from "../src/domain/vm.ts";
import { MemorySecretStore } from "../src/infra/keychain.ts";
import { silentLogger } from "../src/infra/log.ts";
import { resolvePaths } from "../src/infra/paths.ts";

export async function tempDir(prefix = "vm-manager-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function vm(overrides: Partial<VmInput> = {}): Vm {
  return parseVm({
    name: "web-prod",
    group: "Web",
    env: "prod",
    host: "192.0.2.10",
    user: "deploy",
    auth: { kind: "password" },
    agent: "read-free-change-approve",
    ...overrides,
  });
}

/** A clock that only moves when something sleeps on it, so approval timeouts run instantly. */
export class FakeClock implements Clock {
  constructor(public time = Date.parse("2026-11-01T08:00:00Z")) {}
  now() {
    return this.time;
  }
  async sleep(ms: number) {
    this.time += ms;
    await Promise.resolve();
  }
}

export class FakeRunner implements Runner {
  readonly calls: { vm: string; command: string; options?: RunOptions }[] = [];
  constructor(private readonly result: Partial<RunResult> = {}) {}
  async run(vm: Vm, command: string, options?: RunOptions): Promise<RunResult> {
    this.calls.push({ vm: vm.name, command, options });
    return { exitCode: 0, stdout: "ok\n", stderr: "", outputBytes: 3, truncated: false, timedOut: false, durationMs: 12, ...this.result };
  }
}

/** A context on a temp HOME with an in-memory Keychain and a fake ssh. Nothing touches the real ~. */
export async function testContext({ runner = new FakeRunner(), clock = new FakeClock() }: { runner?: Runner; clock?: FakeClock } = {}): Promise<Context & { clock: FakeClock; secrets: MemorySecretStore }> {
  const home = await tempDir();
  const paths = resolvePaths({ HOME: home });
  const approvals = new ApprovalStore(paths.approvalsDir, clock);
  const audit = new AuditLog(paths.auditFile, () => clock.now());
  const secrets = new MemorySecretStore();
  return {
    paths,
    inventory: new InventoryStore(paths),
    approvals,
    audit,
    secrets,
    sessions: new AskpassSessions(paths.askpassDir, ["/usr/bin/false"], () => clock.now()),
    runner,
    supervisor: new Supervisor({ approvals, audit, runner, pollMs: 1000 }),
    log: silentLogger,
    clock,
  };
}
