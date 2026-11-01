import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NetworkState } from "../src/core/status.ts";
import { settle } from "../src/core/supervisor.ts";
import { buildMcpServer } from "../src/surfaces/mcp.ts";
import { FakeRunner, testContext, vm } from "./support.ts";

const network: NetworkState = { openvpn: { up: false, interface: null, via: null, routes: ["192.0.2.0/24"] }, tailscale: { installed: false, running: false, tailnet: null } };

async function connect() {
  const runner = new FakeRunner();
  const ctx = await testContext({ runner });
  await ctx.inventory.init({ example: true });
  await ctx.secrets.set(ctx.paths.keychainService, "shop-web-prod", "hunter2-password");
  const server = buildMcpServer(ctx, {
    env: { CLAUDE_PROJECT_DIR: "/Users/alex/shop" },
    network: async () => network,
    probeFn: async (host) => ({ open: host.startsWith("198.51.100."), latencyMs: 10, error: null }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: Boolean(result.isError), structured: result.structuredContent as Record<string, unknown> | undefined };
  };
  return { ctx, runner, call, client };
}

describe("MCP server", () => {
  test("offers exactly the four tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_vms", "vm_change", "vm_logs", "vm_read"]);
    expect(tools.find((t) => t.name === "vm_read")?.annotations?.readOnlyHint).toBe(true);
  });

  test("list_vms shows names, groups, env, reachability and policy, and no addresses, users, keys or passwords", async () => {
    const { call } = await connect();
    const { text, structured } = await call("list_vms");
    expect(text).toContain("shop-web-prod · Shop · prod · reachable · read-free-change-approve");
    expect(text).toContain("shop-api-dev · Shop · dev · needs_vpn · free");
    const dump = text + JSON.stringify(structured);
    for (const secret of ["hunter2-password", "198.51.100.20", "192.0.2.41", "deploy", "id_ed25519_shop", "identityFile", "inactive-"]) {
      expect(dump).not.toContain(secret);
    }
    const vms = (structured?.vms ?? []) as Record<string, unknown>[];
    expect(vms).toHaveLength(7);
    expect(Object.keys(vms[0] ?? {}).sort()).toEqual(["env", "group", "name", "network", "notes", "policy", "reachability"]);
  });

  test("vm_read runs read-only commands and rejects the rest", async () => {
    const { call, runner } = await connect();
    expect((await call("vm_read", { vm: "gpu-train-01", command: "nvidia-smi" })).text).toContain("exit code 0");
    const rejected = await call("vm_read", { vm: "gpu-train-01", command: "sudo systemctl restart docker" });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("vm_change");
    expect(runner.calls.map((c) => c.command)).toEqual(["nvidia-smi"]);
  });

  test("vm_change on a free server runs; on a prod server it waits for approval", async () => {
    const { ctx, call, runner } = await connect();
    expect((await call("vm_change", { vm: "shop-api-dev", command: "docker compose up -d" })).isError).toBe(false);

    const realSleep = ctx.clock.sleep.bind(ctx.clock);
    ctx.clock.sleep = async (ms) => {
      const [pending] = await ctx.approvals.pending();
      if (pending) await settle(ctx, pending.id, "approved", "app");
      await realSleep(ms);
    };
    const result = await call("vm_change", { vm: "shop-payments-prod", command: "systemctl restart nginx", why: "pick up the new certificate" });
    expect(result.text).toContain("approved (request");
    expect(runner.calls.map((c) => c.command)).toEqual(["docker compose up -d", "systemctl restart nginx"]);
    const [approval] = await ctx.approvals.list();
    expect(approval).toMatchObject({ vm: "shop-payments-prod", env: "prod", why: "pick up the new certificate", requester: "test-agent in shop", status: "approved" });
  });

  test("vm_change refuses blocklisted commands and inactive servers", async () => {
    const { call, runner } = await connect();
    expect((await call("vm_change", { vm: "shop-api-dev", command: "sudo reboot" })).text).toContain("hard blocklist");
    expect((await call("vm_change", { vm: "inactive-198-51-100-50", command: "uptime" })).text).toContain("inactive");
    expect(runner.calls).toHaveLength(0);
  });

  test("vm_logs builds the docker or journalctl command and rejects odd names", async () => {
    const { call, runner } = await connect();
    await call("vm_logs", { vm: "warehouse", container: "api", lines: 50 });
    await call("vm_logs", { vm: "warehouse", unit: "nginx.service" });
    expect(runner.calls.map((c) => c.command)).toEqual(["docker logs --tail 50 api", "journalctl -u nginx.service -n 200 --no-pager"]);
    expect((await call("vm_logs", { vm: "warehouse", container: "api; reboot" })).isError).toBe(true);
    expect((await call("vm_logs", { vm: "warehouse" })).text).toContain("exactly one");
  });

  test("unknown servers get a clear error", async () => {
    const { call } = await connect();
    const result = await call("vm_read", { vm: "nope", command: "uptime" });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("No server named");
  });

  test("the audit log has the agent's commands", async () => {
    const { ctx, call } = await connect();
    await call("vm_read", { vm: "gpu-train-01", command: "df -h" });
    await call("vm_read", { vm: "gpu-train-01", command: "rm -rf /tmp/x" });
    expect((await ctx.audit.read()).map((e) => [e.vm, e.command, e.decision, e.requester])).toEqual([
      ["gpu-train-01", "df -h", "allowed", "test-agent in shop"],
      ["gpu-train-01", "rm -rf /tmp/x", "refused", "test-agent in shop"],
    ]);
  });
});
