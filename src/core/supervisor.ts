import { decide, type Tool } from "../domain/policy.ts";
import type { Vm } from "../domain/vm.ts";
import type { Approval, ApprovalStore } from "./approvals.ts";
import type { AuditLog } from "./audit.ts";
import { UserError } from "./errors.ts";
import type { Runner, RunOptions, RunResult } from "./ssh.ts";

export type Outcome =
  | { status: "ran"; vm: string; result: RunResult; approval: Approval | null }
  | { status: "refused"; vm: string; reason: string }
  | { status: "denied" | "expired"; vm: string; approval: Approval };

export interface ExecuteRequest {
  vm: Vm;
  command: string;
  tool: Tool;
  requester: string;
  confirmDestructive?: boolean;
  /** The agent's own words on why it wants this; shown next to the approval. */
  why?: string;
  run?: RunOptions;
  /** Called once an approval request exists, so the caller can say where to approve it. */
  onPending?: (approval: Approval) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * The one path every agent or `vm exec` command takes to a server:
 * policy decision → (approval) → ssh → audit. Nothing here ever sees a password.
 */
export class Supervisor {
  constructor(
    private readonly deps: {
      approvals: ApprovalStore;
      audit: AuditLog;
      runner: Runner;
      approvalTimeoutMs?: number;
      pollMs?: number;
    },
  ) {}

  async execute(req: ExecuteRequest): Promise<Outcome> {
    const { vm, command, tool, requester } = req;
    const kind = tool;
    if (!vm.active) {
      return this.refuse(req, `${vm.name} is marked inactive. Turn it back on in VM Manager first.`);
    }
    const decision = decide({ command, policy: vm.agent, tool, confirmDestructive: req.confirmDestructive });
    if (decision.kind === "refuse") return this.refuse(req, decision.reason);

    let approval: Approval | null = null;
    if (decision.kind === "approve") {
      approval = await this.deps.approvals.create({
        vm: vm.name,
        env: vm.env,
        command,
        requester,
        reason: decision.reason,
        why: req.why ?? null,
        timeoutMs: this.deps.approvalTimeoutMs,
      });
      await this.deps.audit.record({ kind, vm: vm.name, command, requester, decision: "requested", reason: decision.reason, approvalId: approval.id });
      await req.onPending?.(approval);
      approval = await this.deps.approvals.wait(approval.id, { pollMs: this.deps.pollMs, signal: req.signal });
      if (approval.status !== "approved") {
        const status = approval.status === "denied" ? "denied" : "expired";
        await this.deps.audit.record({ kind, vm: vm.name, command, requester, decision: status, reason: approval.decidedBy, approvalId: approval.id });
        return { status, vm: vm.name, approval };
      }
    }

    let result: RunResult;
    try {
      result = await this.deps.runner.run(vm, command, req.run);
    } catch (err) {
      const reason = err instanceof UserError ? err.message : `ssh failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.deps.audit.record({ kind, vm: vm.name, command, requester, decision: "refused", reason, approvalId: approval?.id ?? null });
      return { status: "refused", vm: vm.name, reason };
    }
    await this.deps.audit.record({
      kind,
      vm: vm.name,
      command,
      requester,
      decision: approval ? "approved" : "allowed",
      reason: result.timedOut ? "timed out" : decision.reason,
      approvalId: approval?.id ?? null,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
    });
    return { status: "ran", vm: vm.name, result, approval };
  }

  private async refuse(req: ExecuteRequest, reason: string): Promise<Outcome> {
    await this.deps.audit.record({ kind: req.tool, vm: req.vm.name, command: req.command, requester: req.requester, decision: "refused", reason });
    return { status: "refused", vm: req.vm.name, reason };
  }
}

/** The text an agent (or `vm exec`) gets back. */
export function describeOutcome(outcome: Outcome): string {
  switch (outcome.status) {
    case "refused":
      return `Refused on ${outcome.vm}: ${outcome.reason}`;
    case "denied":
      return `The user denied this command on ${outcome.vm} (request ${outcome.approval.id}). Do not retry it; ask the user what they want instead.`;
    case "expired":
      return `No one approved this command on ${outcome.vm} within the time limit (request ${outcome.approval.id}). It did not run.`;
    case "ran": {
      const r = outcome.result;
      const head = [
        `${outcome.vm}: ${r.timedOut ? "timed out and was stopped" : `exit code ${r.exitCode}`}`,
        `${(r.durationMs / 1000).toFixed(1)} s`,
        outcome.approval ? `approved (request ${outcome.approval.id})` : null,
        r.truncated ? `output cut to the first ${Math.round((r.stdout.length + r.stderr.length) / 1000)} KB of ${Math.round(r.outputBytes / 1000)} KB` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const parts = [head];
      if (r.stdout) parts.push(`--- stdout ---\n${r.stdout.replace(/\n$/, "")}`);
      if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.replace(/\n$/, "")}`);
      if (!r.stdout && !r.stderr) parts.push("(no output)");
      return parts.join("\n");
    }
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/** `vm approve` / `vm deny` and the app's buttons: decide a request and write it to the audit log. */
export async function settle(
  { approvals, audit }: { approvals: ApprovalStore; audit: AuditLog },
  id: string,
  status: "approved" | "denied",
  by: string,
): Promise<Approval> {
  const approval = await approvals.decide(id, status, by);
  await audit.record({
    kind: "approval",
    vm: approval.vm,
    command: approval.command,
    requester: by,
    decision: status,
    reason: `request ${approval.id} from ${approval.requester}`,
    approvalId: approval.id,
  });
  return approval;
}
