import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";
import { withLock } from "../infra/lock.ts";
import { UserError } from "./errors.ts";

export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export const ApprovalSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  vm: z.string(),
  env: z.enum(["prod", "dev"]),
  command: z.string(),
  requester: z.string(),
  reason: z.string(),
  why: z.string().nullable().default(null),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalStatus = Approval["status"];

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/**
 * One JSON file per request in approvals/<id>.json. The agent's call waits on its file; the app
 * or `vm approve` flips it. A request only moves out of pending once, so a late click can't
 * approve a request that already timed out.
 */
export class ApprovalStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private file(id: string) {
    if (!/^[a-f0-9]{8}$/.test(id)) throw new UserError(`"${id}" is not an approval id. See \`vm approvals\`.`);
    return join(this.dir, `${id}.json`);
  }

  private lock(id: string) {
    return join(this.dir, `.${id}.lock`);
  }

  async create(input: {
    vm: string;
    env: "prod" | "dev";
    command: string;
    requester: string;
    reason: string;
    why?: string | null;
    timeoutMs?: number;
  }): Promise<Approval> {
    let id = randomBytes(4).toString("hex");
    while ((await this.find(id)) !== null) id = randomBytes(4).toString("hex");
    const now = this.clock.now();
    const approval: Approval = {
      id,
      vm: input.vm,
      env: input.env,
      command: input.command,
      requester: input.requester,
      reason: input.reason,
      why: input.why?.trim() ? input.why.trim().slice(0, 500) : null,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.timeoutMs ?? APPROVAL_TIMEOUT_MS)).toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    await writeJsonAtomic(this.file(id), approval);
    return approval;
  }

  async find(id: string): Promise<Approval | null> {
    try {
      return await readJson(this.file(id), ApprovalSchema);
    } catch (err) {
      if (err instanceof UserError) throw err;
      return null;
    }
  }

  async get(id: string): Promise<Approval> {
    const approval = await this.find(id);
    if (!approval) throw new UserError(`No approval request ${id}. See \`vm approvals\`.`);
    return this.withExpiry(approval);
  }

  /** Newest first. Pending requests past their deadline are reported as expired. */
  async list(): Promise<Approval[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => /^[a-f0-9]{8}\.json$/.test(n)).map((n) => this.find(n.slice(0, 8))));
    return all
      .filter((a): a is Approval => a !== null)
      .map((a) => this.withExpiry(a))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async pending(): Promise<Approval[]> {
    return (await this.list()).filter((a) => a.status === "pending");
  }

  /** Approves or denies a pending request. Returns the request as it ends up. */
  async decide(id: string, status: "approved" | "denied" | "expired", by: string): Promise<Approval> {
    return withLock(this.lock(id), async () => {
      const current = await this.find(id);
      if (!current) throw new UserError(`No approval request ${id}. See \`vm approvals\`.`);
      if (current.status !== "pending") throw new UserError(`Request ${id} is already ${current.status}.`);
      const now = this.clock.now();
      const decidedAt = new Date(now).toISOString();
      if (status !== "expired" && Date.parse(current.expiresAt) <= now) {
        await writeJsonAtomic(this.file(id), { ...current, status: "expired", decidedAt, decidedBy: "timeout" });
        throw new UserError(`Request ${id} expired before it was ${status}. The agent was told it was not approved.`);
      }
      const next: Approval = { ...current, status, decidedAt, decidedBy: by };
      await writeJsonAtomic(this.file(id), next);
      return next;
    });
  }

  /** Waits until the request is decided or its deadline passes; a request still pending then is marked expired. */
  async wait(id: string, { pollMs = 500, signal }: { pollMs?: number; signal?: AbortSignal } = {}): Promise<Approval> {
    for (;;) {
      const approval = await this.get(id);
      if (approval.status !== "pending") {
        if (approval.status === "expired") return this.expire(approval);
        return approval;
      }
      if (signal?.aborted) return this.expire(approval, "cancelled");
      await this.clock.sleep(pollMs);
    }
  }

  private async expire(approval: Approval, by = "timeout"): Promise<Approval> {
    try {
      return await this.decide(approval.id, "expired", by);
    } catch {
      // Someone decided it in the same instant; their decision stands.
      return this.get(approval.id);
    }
  }

  private withExpiry(approval: Approval): Approval {
    if (approval.status === "pending" && Date.parse(approval.expiresAt) <= this.clock.now()) return { ...approval, status: "expired" };
    return approval;
  }
}
