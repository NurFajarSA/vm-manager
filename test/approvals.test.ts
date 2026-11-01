import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { APPROVAL_TIMEOUT_MS, ApprovalStore } from "../src/core/approvals.ts";
import { UserError } from "../src/core/errors.ts";
import { FakeClock, tempDir } from "./support.ts";

const request = { vm: "web-prod", env: "prod" as const, command: "systemctl restart nginx", requester: "claude-code in shop", reason: "changes on this server need approval" };

async function store(clock = new FakeClock()) {
  return { store: new ApprovalStore(join(await tempDir(), "approvals"), clock), clock };
}

describe("approvals", () => {
  test("a new request is pending, private, and expires in 10 minutes", async () => {
    const { store: s, clock } = await store();
    const a = await s.create({ ...request, why: "pick up the new config" });
    expect(a.id).toMatch(/^[a-f0-9]{8}$/);
    expect(a.status).toBe("pending");
    expect(a.why).toBe("pick up the new config");
    expect(Date.parse(a.expiresAt) - clock.now()).toBe(APPROVAL_TIMEOUT_MS);
    const dir = join(s["dir"] as string);
    const file = join(dir, `${a.id}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).command).toBe(request.command);
    expect(await s.pending()).toHaveLength(1);
  });

  test("approve, then the request can't be decided again", async () => {
    const { store: s } = await store();
    const a = await s.create(request);
    const approved = await s.decide(a.id, "approved", "app");
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("app");
    expect(approved.decidedAt).not.toBeNull();
    await expect(s.decide(a.id, "denied", "cli")).rejects.toThrow("already approved");
    expect((await s.get(a.id)).status).toBe("approved");
  });

  test("deny", async () => {
    const { store: s } = await store();
    const a = await s.create(request);
    expect((await s.decide(a.id, "denied", "cli")).status).toBe("denied");
    expect(await s.pending()).toHaveLength(0);
  });

  test("wait returns as soon as someone decides", async () => {
    const { store: s, clock } = await store();
    const a = await s.create(request);
    const realSleep = clock.sleep.bind(clock);
    let ticks = 0;
    clock.sleep = async (ms) => {
      if (++ticks === 3) await s.decide(a.id, "approved", "app");
      await realSleep(ms);
    };
    const result = await s.wait(a.id, { pollMs: 1000 });
    expect(result.status).toBe("approved");
    expect(ticks).toBe(3);
  });

  test("wait marks a request expired after the timeout, and a late approval fails", async () => {
    const { store: s, clock } = await store();
    const a = await s.create({ ...request, timeoutMs: 5000 });
    const result = await s.wait(a.id, { pollMs: 1000 });
    expect(result.status).toBe("expired");
    expect(result.decidedBy).toBe("timeout");
    expect(clock.now() - Date.parse(a.createdAt)).toBeGreaterThanOrEqual(5000);
    await expect(s.decide(a.id, "approved", "app")).rejects.toThrow("already expired");
  });

  test("approving after the deadline, before the waiter noticed, is refused", async () => {
    const { store: s, clock } = await store();
    const a = await s.create({ ...request, timeoutMs: 5000 });
    clock.time += 6000;
    expect((await s.get(a.id)).status).toBe("expired");
    await expect(s.decide(a.id, "approved", "app")).rejects.toThrow("expired before it was approved");
    expect((await s.find(a.id))?.status).toBe("expired");
  });

  test("a cancelled wait withdraws the request", async () => {
    const { store: s } = await store();
    const a = await s.create(request);
    const controller = new AbortController();
    controller.abort();
    const result = await s.wait(a.id, { signal: controller.signal });
    expect(result.status).toBe("expired");
    expect(result.decidedBy).toBe("cancelled");
  });

  test("list is newest first and ignores stray files", async () => {
    const { store: s, clock } = await store();
    const first = await s.create(request);
    clock.time += 1000;
    const second = await s.create({ ...request, command: "docker compose up -d" });
    await Bun.write(join(s["dir"] as string, "notes.txt"), "hello");
    await Bun.write(join(s["dir"] as string, "deadbeef.json"), "{ broken");
    expect((await s.list()).map((a) => a.id)).toEqual([second.id, first.id]);
    expect((await readdir(s["dir"] as string)).length).toBeGreaterThanOrEqual(4);
  });

  test("ids are validated, so a crafted id can't point outside the folder", async () => {
    const { store: s } = await store();
    await expect(s.get("../../vms")).rejects.toBeInstanceOf(UserError);
    await expect(s.decide("../x", "approved", "cli")).rejects.toBeInstanceOf(UserError);
  });
});
