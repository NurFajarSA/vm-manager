import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type { Context } from "../core/context.ts";
import { UserError } from "../core/errors.ts";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../core/ssh.ts";
import { checkStatus, detectNetwork, type NetworkState, type probe } from "../core/status.ts";
import { describeOutcome } from "../core/supervisor.ts";
import { POLICY_LABELS } from "../domain/vm.ts";

export const VERSION: string = pkg.version;

const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;

export interface McpOptions {
  env?: NodeJS.ProcessEnv;
  network?: () => Promise<NetworkState>;
  probeFn?: typeof probe;
}

export function buildMcpServer(ctx: Context, { env = process.env, network = async () => detectNetwork(await ctx.inventory.vpnRoutes()), probeFn }: McpOptions = {}): McpServer {
  const server = new McpServer({ name: "vm-manager", version: VERSION });

  const requester = () => {
    const client = server.server.getClientVersion()?.name ?? "MCP client";
    const project = env.CLAUDE_PROJECT_DIR || process.cwd();
    const session = env.CLAUDE_CODE_HOST_SESSION_ID ?? env.CLAUDE_SESSION_ID;
    return [`${client} in ${basename(project) || project}`, session ? `session ${session.slice(0, 16)}` : null].filter(Boolean).join(", ");
  };

  const agentVm = async (name: string) => {
    const vm = await ctx.inventory.get(name);
    if (!vm.active) throw new UserError(`${vm.name} is inactive.`);
    return vm;
  };

  server.registerTool(
    "list_vms",
    {
      title: "List servers",
      description:
        "List the user's SSH servers: name, group, prod or dev, network, whether it answers right now, and what agents may do on it. Use the name with vm_read, vm_change and vm_logs. Policies: 'free' runs any command; 'read-free-change-approve' runs read-only commands and asks the user before anything else; 'none' means no agent access.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded(async () => {
        const vms = (await ctx.inventory.list()).filter((v) => v.active);
        const report = await checkStatus(vms, { network: await network(), probeFn });
        const rows = vms.map((vm) => {
          const status = report.vms.find((s) => s.name === vm.name);
          return {
            name: vm.name,
            group: vm.group,
            env: vm.env,
            network: vm.network,
            reachability: status?.state ?? "unreachable",
            policy: vm.agent,
            notes: vm.notes,
          };
        });
        const text = [
          "Servers (name · group · env · reachability · agent policy):",
          ...rows.map((r) => `- ${r.name} · ${r.group} · ${r.env} · ${r.reachability} · ${r.policy} (${POLICY_LABELS[r.policy]})${r.notes ? `\n  ${r.notes}` : ""}`),
          "",
          "Use vm_read for read-only commands (cat, tail, ls, df, ps, docker ps/logs, systemctl status, journalctl, git status/log…). Use vm_change for anything else.",
        ].join("\n");
        return { text, structured: { vms: rows } };
      }),
  );

  const timeout = z.number().int().min(1).max(MAX_TIMEOUT_MS / 1000).optional().describe(`Seconds before the command is stopped (default ${DEFAULT_TIMEOUT_MS / 1000})`);

  server.registerTool(
    "vm_read",
    {
      title: "Run a read-only command on a server",
      description:
        "Run one read-only command on a server over ssh and get its output (up to 200 KB). Only a fixed list counts as read-only (cat, head, tail, less, ls, grep, find without -exec, df, du, free, uptime, ps, top -b -n1, journalctl, systemctl status, docker ps/logs/inspect/images, docker compose ps/logs, git status/log/diff/show, ss, netstat, ip a, curl -I, nvidia-smi), with no pipes, redirects, ;, &&, $() or backticks. sudo makes a command a change. Anything else is rejected; use vm_change for it.",
      inputSchema: {
        vm: z.string().describe("Server name from list_vms"),
        command: z.string().describe("One command, for example `docker ps -a` or `tail -n 200 /var/log/nginx/error.log`"),
        timeout_seconds: timeout,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ vm, command, timeout_seconds }) =>
      guarded(async () => {
        const outcome = await ctx.supervisor.execute({
          vm: await agentVm(vm),
          command,
          tool: "read",
          requester: requester(),
          run: { timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined },
        });
        return { text: describeOutcome(outcome), error: outcome.status !== "ran" };
      }),
  );

  server.registerTool(
    "vm_change",
    {
      title: "Run a command that may change a server",
      description:
        "Run any command on a server over ssh. On 'free' servers it runs right away. On 'read-free-change-approve' servers the user sees the exact command in VM Manager and approves or denies it; this call waits up to 10 minutes for that. On 'none' servers it is refused. A few commands are always refused (rm -rf /, mkfs, dd of=/dev/, shutdown, reboot, poweroff, halt, fork bombs). DROP DATABASE, DROP TABLE and TRUNCATE also need confirm_destructive: true, and then the user's approval on every server. If the user denies a command, do not retry it; ask them instead.",
      inputSchema: {
        vm: z.string().describe("Server name from list_vms"),
        command: z.string().describe("The shell command to run, exactly as it should run"),
        why: z.string().max(500).optional().describe("One sentence for the person approving: what this does and why"),
        confirm_destructive: z.boolean().optional().describe("Only true when the user asked for a DROP or TRUNCATE"),
        timeout_seconds: timeout,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ vm, command, why, confirm_destructive, timeout_seconds }, extra) =>
      guarded(async () => {
        const outcome = await ctx.supervisor.execute({
          vm: await agentVm(vm),
          command,
          tool: "change",
          requester: requester(),
          why,
          confirmDestructive: confirm_destructive ?? false,
          // If the client gives up waiting, the request is withdrawn instead of staying approvable.
          signal: extra.signal,
          run: { timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined },
        });
        return { text: describeOutcome(outcome), error: outcome.status !== "ran" };
      }),
  );

  server.registerTool(
    "vm_logs",
    {
      title: "Read recent logs from a container or service",
      description:
        "Shortcut for the last lines of a Docker container's logs (`docker logs --tail N <container>`) or a systemd unit's journal (`journalctl -u <unit> -n N`). Read-only. Pass exactly one of container or unit.",
      inputSchema: {
        vm: z.string().describe("Server name from list_vms"),
        container: z.string().optional().describe("Docker container name or id"),
        unit: z.string().optional().describe("systemd unit, for example nginx or docker.service"),
        lines: z.number().int().min(1).max(5000).optional().describe("How many lines (default 200)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ vm, container, unit, lines }) =>
      guarded(async () => {
        if (Boolean(container) === Boolean(unit)) throw new UserError("Pass exactly one of container or unit.");
        const name = (container ?? unit) as string;
        if (!UNIT.test(name)) throw new UserError(`"${name}" is not a plain container or unit name.`);
        const n = lines ?? 200;
        const command = container ? `docker logs --tail ${n} ${name}` : `journalctl -u ${name} -n ${n} --no-pager`;
        const outcome = await ctx.supervisor.execute({ vm: await agentVm(vm), command, tool: "read", requester: requester() });
        return { text: describeOutcome(outcome), error: outcome.status !== "ran" };
      }),
  );

  return server;
}

export async function serveMcp(ctx: Context, options: McpOptions & { transport?: Transport } = {}): Promise<void> {
  const server = buildMcpServer(ctx, options);
  await server.connect(options.transport ?? new StdioServerTransport());
}

async function guarded(fn: () => Promise<{ text: string; error?: boolean; structured?: Record<string, unknown> }>) {
  try {
    const { text, error, structured } = await fn();
    return {
      content: [{ type: "text" as const, text }],
      ...(error ? { isError: true } : {}),
      ...(structured ? { structuredContent: structured } : {}),
    };
  } catch (err) {
    const text = err instanceof UserError ? err.message : `Failed: ${err instanceof Error ? err.message : String(err)}`;
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
}
