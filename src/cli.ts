import { parseArgs } from "node:util";
import { answerAskpass, parentProcessName } from "./core/askpass.ts";
import { createContext } from "./core/context.ts";
import { UserError } from "./core/errors.ts";
import { keySetup, localKeys } from "./core/keysetup.ts";
import { interactiveSsh } from "./core/ssh.ts";
import { sshConfigSynced, syncSshConfig, renderSshConfig } from "./core/sshconfig.ts";
import { checkStatus, detectNetwork, loadStatus, saveStatus } from "./core/status.ts";
import { describeOutcome, settle } from "./core/supervisor.ts";
import { checkBlocklist, classify, decide, DESTRUCTIVE, HARD_BLOCKS, READ_ONLY_SUMMARY } from "./domain/policy.ts";
import { AGENT_POLICIES, ENVS, NETWORKS, POLICY_LABELS, type Vm } from "./domain/vm.ts";
import { tildify } from "./infra/paths.ts";
import { install, loginItemEnabled, mcpAddArgs, layout, setLoginItem, uninstall } from "./surfaces/install.ts";
import { serveMcp, VERSION } from "./surfaces/mcp.ts";
import { paint, renderApprovals, renderAudit, renderList, renderStatus, toRows } from "./surfaces/view.ts";

const ctx = createContext();
const { paths, inventory } = ctx;
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = paint(color);

type Handler = (args: string[]) => Promise<void>;

interface Command {
  usage: string;
  summary: string;
  run: Handler;
  hidden?: boolean;
}

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};
const json = (value: unknown) => out(JSON.stringify(value, null, 2));

const VM_FIELDS = {
  host: { type: "string" },
  user: { type: "string" },
  port: { type: "string" },
  group: { type: "string" },
  env: { type: "string" },
  key: { type: "string" },
  password: { type: "boolean" },
  network: { type: "string" },
  alias: { type: "string", multiple: true },
  notes: { type: "string" },
  agent: { type: "string" },
  active: { type: "string" },
  json: { type: "boolean" },
} as const;

/** Applies `vm add` / `vm edit` flags to a server (or to an empty one). */
function applyFlags(base: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const field of ["host", "user", "group", "notes"] as const) if (typeof values[field] === "string") next[field] = values[field];
  if (typeof values.port === "string") next.port = Number(values.port);
  if (typeof values.env === "string") next.env = oneOf(values.env, ENVS, "env");
  if (typeof values.network === "string") next.network = oneOf(values.network, NETWORKS, "network");
  if (typeof values.agent === "string") next.agent = oneOf(values.agent, AGENT_POLICIES, "agent");
  if (typeof values.active === "string") next.active = values.active === "true" || values.active === "yes";
  if (Array.isArray(values.alias)) next.aliases = values.alias.flatMap((a: string) => a.split(",")).map((a: string) => a.trim()).filter(Boolean);
  if (typeof values.key === "string") next.auth = { kind: "key", identityFile: values.key };
  if (values.password === true) next.auth = { kind: "password" };
  return next;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new UserError(`--${name} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await Bun.stdin.text());
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new UserError("Expected one server as a JSON object on stdin.");
  }
}

/** Reads a password without echoing it. With --stdin (the app), it reads one line from stdin instead. */
async function readSecret(prompt: string, fromStdin: boolean): Promise<string> {
  if (fromStdin || !process.stdin.isTTY) return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  process.stderr.write(prompt);
  const stty = (arg: string) => Bun.spawnSync(["/bin/stty", arg], { stdin: "inherit" });
  stty("-echo");
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    stty("echo");
    process.stderr.write("\n");
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${question} [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

async function listRows(vms: Vm[]) {
  const sshSynced = await sshConfigSynced(paths, vms);
  return { rows: await toRows(vms, { home: paths.home, secrets: ctx.secrets, service: paths.keychainService, sshSynced }), sshSynced };
}

async function runStatus() {
  const { vms: all, networks } = await inventory.load();
  const vms = all.filter((v) => v.active);
  const report = await checkStatus(vms, { network: await detectNetwork(networks?.openvpn?.routes ?? []) });
  await saveStatus(paths.statusFile, report);
  return report;
}

const COMMANDS: Record<string, Command> = {
  init: {
    usage: "vm init [--example]",
    summary: "Create an empty server list (or a made-up example), if there is none yet",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { example: { type: "boolean" } } });
      const file = tildify(paths.vmsFile, paths.home);
      const { created, count } = await inventory.init({ example: values.example ?? false });
      if (!created) return out(`${file} already exists (${count} servers). Nothing changed.`);
      if (values.example) {
        out(`Created ${file} with ${count} made-up example servers (documentation addresses, none of them real).`);
        out("Look around with `vm list`, then replace them with yours: `vm remove <name>` and `vm add`.");
      } else {
        out(`Created ${file} with no servers yet.`);
        out("Next: `vm add <name> --host <ip> --user <user> --key <file>` (or `--password`), then `vm sync-ssh`.");
        out("If some servers sit behind OpenVPN, set the subnets it routes: `vm vpn-routes 10.8.0.0/16`.");
      }
    },
  },
  list: {
    usage: "vm list [--json]",
    summary: "Every server with its address, login, network and agent policy",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
      const { vms, networks } = await inventory.load();
      const { rows, sshSynced } = await listRows(vms);
      if (values.json) return json({ vms: rows, networks: { openvpn: { routes: networks?.openvpn?.routes ?? [] } }, sshSynced, stateDir: paths.stateDir });
      out(renderList(rows, { color, home: paths.home, status: await loadStatus(paths.statusFile) }));
      if (!sshSynced) out(`\n${c.dim("~/.ssh/config does not have these servers yet. Run `vm sync-ssh` to use `ssh <name>` anywhere.")}`);
    },
  },
  status: {
    usage: "vm status [--json]",
    summary: "Which servers answer on their SSH port right now, and whether the VPN is on",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
      const report = await runStatus();
      if (values.json) return json(report);
      out(renderStatus(report, color));
    },
  },
  ssh: {
    usage: "vm ssh <name> [-- ssh options]",
    summary: "Open a shell on a server (passwords come from the Keychain)",
    run: async (args) => {
      const [name, ...rest] = args;
      if (!name) throw new UserError("Usage: vm ssh <name>");
      const vm = await inventory.get(name);
      const extra = rest[0] === "--" ? rest.slice(1) : rest;
      process.exitCode = await interactiveSsh(vm, { home: paths.home, sessions: ctx.sessions, extra });
    },
  },
  exec: {
    usage: "vm exec <name> [--why text] [--confirm-destructive] [--timeout s] -- <command>",
    summary: "Run a command under the same rules as an agent (prod changes wait for approval)",
    run: async (args) => {
      const split = args.indexOf("--");
      if (split < 0) throw new UserError("Usage: vm exec <name> -- <command>");
      const { values, positionals } = parseArgs({
        args: args.slice(0, split),
        allowPositionals: true,
        options: { why: { type: "string" }, "confirm-destructive": { type: "boolean" }, timeout: { type: "string" } },
      });
      const [name] = positionals;
      const command = args.slice(split + 1).join(" ");
      if (!name || !command) throw new UserError("Usage: vm exec <name> -- <command>");
      const outcome = await ctx.supervisor.execute({
        vm: await inventory.get(name),
        command,
        tool: "change",
        requester: "cli",
        why: values.why,
        confirmDestructive: values["confirm-destructive"] ?? false,
        run: { timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined },
        onPending: (a) => err(`Waiting for approval of request ${a.id}. Approve it in VM Manager, or run \`vm approve ${a.id}\`.`),
      });
      if (outcome.status !== "ran") throw new UserError(describeOutcome(outcome));
      const r = outcome.result;
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.truncated) err(c.dim(`(output cut at ${r.stdout.length + r.stderr.length} of ${r.outputBytes} bytes)`));
      if (r.timedOut) err("Timed out; the command was stopped.");
      process.exitCode = r.exitCode ?? 124;
    },
  },
  add: {
    usage: "vm add <name> --host <ip> --user <user> --key <file>|--password [options]",
    summary: "Add a server. Options: --group --env --network --agent --alias --notes --port, or --json on stdin",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: VM_FIELDS });
      const input = values.json ? await readStdinJson() : applyFlags({ name: positionals[0], group: "Other", env: "dev" }, values);
      if (!values.json && !positionals[0]) throw new UserError("Usage: vm add <name> --host <ip> --user <user> [--key <file> | --password]");
      if (!input.auth) throw new UserError("Pass --key <file> or --password.");
      const vm = await inventory.put(input);
      out(`Added ${vm.name} (${vm.user}@${vm.host}).${vm.auth.kind === "password" ? ` Save its password with \`vm password ${vm.name}\`.` : ""}`);
    },
  },
  edit: {
    usage: "vm edit <name> [--name new] [vm add options] [--active true|false]",
    summary: "Change a server (--json reads the whole server from stdin)",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...VM_FIELDS, name: { type: "string" } } });
      const [name] = positionals;
      if (!name) throw new UserError("Usage: vm edit <name> --field value");
      const current = await inventory.get(name);
      const input = values.json ? await readStdinJson() : applyFlags({ ...current, ...(values.name ? { name: values.name } : {}) }, values);
      const vm = await inventory.put(input, { replacing: current.name });
      if (vm.name !== current.name && current.auth.kind === "password") {
        const secret = await ctx.secrets.get(paths.keychainService, current.name);
        if (secret !== null) {
          await ctx.secrets.set(paths.keychainService, vm.name, secret);
          await ctx.secrets.delete(paths.keychainService, current.name);
        }
      }
      out(`Saved ${vm.name}.`);
    },
  },
  remove: {
    usage: "vm remove <name>",
    summary: "Remove a server and its saved password",
    run: async ([name]) => {
      if (!name) throw new UserError("Usage: vm remove <name>");
      const vm = await inventory.remove((await inventory.get(name)).name);
      await ctx.secrets.delete(paths.keychainService, vm.name);
      out(`Removed ${vm.name}. Run \`vm sync-ssh\` to drop it from ~/.ssh/config too.`);
    },
  },
  password: {
    usage: "vm password <name> [--stdin | --delete]",
    summary: "Save or replace a server's password in the Keychain",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { stdin: { type: "boolean" }, delete: { type: "boolean" } } });
      const vm = await inventory.get(positionals[0] ?? "");
      if (values.delete) {
        await ctx.secrets.delete(paths.keychainService, vm.name);
        return out(`Removed the saved password for ${vm.name}.`);
      }
      if (vm.auth.kind !== "password") err(c.dim(`${vm.name} logs in with a key; the password is only used by \`vm key-setup\`.`));
      const secret = await readSecret(`Password for ${vm.user}@${vm.host} (not shown): `, values.stdin ?? false);
      if (!secret) throw new UserError("No password entered. Nothing changed.");
      await ctx.secrets.set(paths.keychainService, vm.name, secret);
      out(`Saved the password for ${vm.name} in the Keychain.`);
    },
  },
  "key-setup": {
    usage: "vm key-setup <name> [--key ~/.ssh/id_ed25519] [--generate]",
    summary: "Install an SSH key on a password server, then switch it to key login",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { key: { type: "string" }, generate: { type: "boolean" } } });
      const vm = await inventory.get(positionals[0] ?? "");
      let key = values.key;
      if (!key) {
        const keys = await localKeys(paths.sshDir);
        if (!process.stdin.isTTY) throw new UserError("Pass --key <private key>, or --key <new path> --generate.");
        out("Which key should log in to this server?");
        keys.forEach((k, i) => out(`  ${i + 1}. ${tildify(k, paths.home)}`));
        out(`  ${keys.length + 1}. Create a new key at ~/.ssh/vm-manager_${vm.name}`);
        process.stderr.write("Number: ");
        let choice = 0;
        for await (const line of console) {
          choice = Number(line.trim());
          break;
        }
        if (choice >= 1 && choice <= keys.length) key = keys[choice - 1];
        else if (choice === keys.length + 1) {
          key = `~/.ssh/vm-manager_${vm.name}`;
          values.generate = true;
        } else throw new UserError("No key chosen. Nothing changed.");
      }
      const updated = await keySetup(ctx, vm, { key: key as string, generate: values.generate ?? false }, {
        out,
        spawn: async (cmd, env) => Bun.spawn(cmd, { env, stdio: ["inherit", "inherit", "inherit"] }).exited,
      });
      out(`${updated.name} now logs in with ${updated.auth.kind === "key" ? updated.auth.identityFile : "a key"}.`);
      out(`Run \`vm sync-ssh\` to update ~/.ssh/config. The password stays in the Keychain; \`vm password ${updated.name} --delete\` removes it.`);
    },
  },
  "vpn-routes": {
    usage: "vm vpn-routes [<subnet> ...] [--clear] [--json]",
    summary: "Show or set the subnets your OpenVPN profile routes (how VM Manager tells the VPN is on)",
    run: async (args) => {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { clear: { type: "boolean" }, json: { type: "boolean" } } });
      if (values.clear && positionals.length > 0) throw new UserError("Pass subnets or --clear, not both.");
      const subnets = positionals.flatMap((p) => p.split(",")).map((p) => p.trim()).filter(Boolean);
      const routes = values.clear || subnets.length > 0 ? await inventory.setVpnRoutes(values.clear ? [] : subnets) : await inventory.vpnRoutes();
      if (values.json) return json({ routes });
      if (routes.length === 0) {
        out("VPN subnet not set. Servers on vpn:openvpn are checked, but VM Manager can't tell whether the VPN is on.");
        out("Set it to the subnets your OpenVPN profile routes, for example: vm vpn-routes 10.8.0.0/16");
      } else out(`OpenVPN counts as connected when this Mac has a route to ${routes.join(", ")}.`);
    },
  },
  "sync-ssh": {
    usage: "vm sync-ssh [--dry-run]",
    summary: "Write ~/.ssh/config.d/vm-manager.conf so `ssh <name>` works everywhere",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" } } });
      const vms = await inventory.list();
      if (values["dry-run"]) return out(renderSshConfig(vms));
      const report = await syncSshConfig(paths, vms);
      out(`${report.changed ? "Wrote" : "Up to date:"} ${tildify(report.managedFile, paths.home)} (${report.hosts.length} hosts).`);
      if (report.includeAdded) out(`Added the Include line at the top of ~/.ssh/config.${report.backup ? ` Backup: ${tildify(report.backup, paths.home)}` : ""}`);
      out(`Try: ssh ${report.hosts[0] ?? "<name>"}`);
    },
  },
  approvals: {
    usage: "vm approvals [--all] [--json]",
    summary: "Commands waiting for your approval (--all includes decided ones)",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" }, all: { type: "boolean" } } });
      const all = await ctx.approvals.list();
      if (values.json) return json(all.slice(0, 100));
      out(renderApprovals(values.all ? all.slice(0, 50) : all.filter((a) => a.status === "pending"), color));
    },
  },
  approve: {
    usage: "vm approve <id>",
    summary: "Let a waiting command run",
    run: async ([id]) => {
      if (!id) throw new UserError("Usage: vm approve <id>   (see `vm approvals`)");
      const a = await settle(ctx, id, "approved", process.env.VM_MANAGER_DECIDED_BY ?? "cli");
      out(`Approved ${a.id}: ${a.command} on ${a.vm}.`);
    },
  },
  deny: {
    usage: "vm deny <id>",
    summary: "Stop a waiting command from running",
    run: async ([id]) => {
      if (!id) throw new UserError("Usage: vm deny <id>");
      const a = await settle(ctx, id, "denied", process.env.VM_MANAGER_DECIDED_BY ?? "cli");
      out(`Denied ${a.id}. The agent is told not to retry it.`);
    },
  },
  audit: {
    usage: "vm audit [--vm name] [--limit n] [--json]",
    summary: "Every agent command, approval and denial (no output, no secrets)",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" }, limit: { type: "string", default: "50" }, vm: { type: "string" } } });
      const entries = await ctx.audit.read({ limit: Number(values.limit), vm: values.vm });
      if (values.json) return json(entries);
      out(renderAudit(entries, color));
    },
  },
  policy: {
    usage: "vm policy [--json]",
    summary: "What counts as read-only, and what is always blocked",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
      const policies = AGENT_POLICIES.map((id) => ({ id, label: POLICY_LABELS[id] }));
      if (values.json) return json({ policies, readOnly: READ_ONLY_SUMMARY, hardBlocks: HARD_BLOCKS, destructive: DESTRUCTIVE });
      out(c.bold("Policies"));
      for (const p of policies) out(`  ${p.id.padEnd(26)}${p.label}`);
      out(c.bold("\nRead-only (no ; | & > < $ ( ) ` \\ or newlines, no sudo)"));
      for (const line of READ_ONLY_SUMMARY) out(`  ${line}`);
      out(c.bold("\nAlways refused, even with approval"));
      out(`  ${HARD_BLOCKS.join(", ")}`);
      out(c.bold("\nNeeds confirm_destructive, then approval on every server"));
      out(`  ${DESTRUCTIVE.join(", ")}`);
    },
  },
  check: {
    usage: "vm check [--json] -- <command>",
    summary: "Show how a command would be treated under each policy",
    run: async (args) => {
      const split = args.indexOf("--");
      const { values } = parseArgs({ args: split < 0 ? [] : args.slice(0, split), options: { json: { type: "boolean" } } });
      const command = (split < 0 ? args : args.slice(split + 1)).join(" ");
      if (!command.trim()) throw new UserError("Usage: vm check -- <command>");
      const classification = classify(command);
      const block = checkBlocklist(command);
      const decisions = Object.fromEntries(AGENT_POLICIES.map((policy) => [policy, decide({ command, policy, tool: "change" })]));
      if (values.json) return json({ command, classification, block, decisions });
      out(classification.readOnly ? c.green("Read-only.") : `A change: ${classification.reason}.`);
      if (block) out(c.yellow(block.kind === "hard" ? `On the hard blocklist (${block.rule}).` : `Destroys data (${block.rule}).`));
      for (const [policy, d] of Object.entries(decisions)) out(`  ${policy.padEnd(26)}${d.kind}${d.kind === "refuse" ? `: ${d.reason}` : ""}`);
    },
  },
  "login-item": {
    usage: "vm login-item [on|off]",
    summary: "Show or change whether the menu bar app opens at login",
    run: async ([value]) => {
      if (value === undefined) return out((await loginItemEnabled(paths)) ? "on" : "off");
      if (value !== "on" && value !== "off") throw new UserError("Usage: vm login-item [on|off]");
      out((await setLoginItem({ paths, enabled: value === "on" })) ? "on" : "off");
    },
  },
  mcp: {
    usage: "vm mcp",
    summary: "MCP server over stdio for Claude (registered by `vm install`)",
    run: () => serveMcp(ctx),
  },
  askpass: {
    usage: "vm askpass <name> [prompt]",
    summary: "Answers ssh's password prompt from the Keychain (ssh runs this, not you)",
    hidden: true,
    run: async ([name, prompt]) => {
      const answer = await answerAskpass({
        vm: name ?? "",
        prompt,
        env: process.env,
        sessions: ctx.sessions,
        secrets: ctx.secrets,
        service: paths.keychainService,
        parentName: parentProcessName,
      });
      if (!answer.ok) {
        err(answer.message);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(answer.stdout);
    },
  },
  install: {
    usage: "vm install [--app path/to/VM Manager.app]",
    summary: "Install the vm binary, the menu bar app (opens at login) and the MCP server",
    run: async (args) => {
      const { values } = parseArgs({ args, options: { app: { type: "string" } } });
      if (/\/bun$/.test(process.execPath)) throw new UserError("Run install from the compiled binary: `bun run build && ./dist/vm install`.");
      const steps = await install({ paths, sourceBinary: process.execPath, app: values.app });
      for (const s of steps) out(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      if (steps.some((s) => !s.ok)) process.exitCode = 1;
      else if (!(await inventory.exists())) out("Next: `vm init`.");
    },
  },
  uninstall: {
    usage: "vm uninstall",
    summary: "Remove what `vm install` added (servers, audit log and Keychain items stay)",
    run: async () => {
      for (const s of await uninstall({ paths })) out(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
    },
  },
};

function help(): string {
  const visible = Object.values(COMMANDS).filter((cmd) => !cmd.hidden);
  const width = Math.min(Math.max(...visible.map((cmd) => cmd.usage.length)), 52);
  return [
    `VM Manager ${VERSION}: your SSH servers in one place, with supervised access for Claude`,
    "",
    ...visible.map((cmd) => (cmd.usage.length > width ? `  ${cmd.usage}\n  ${"".padEnd(width)}  ${cmd.summary}` : `  ${cmd.usage.padEnd(width)}  ${cmd.summary}`)),
    "",
    `Data: ${tildify(paths.stateDir, paths.home)}   MCP: claude ${mcpAddArgs(tildify(layout(paths).bin, paths.home)).join(" ")}`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [name = "list", ...rest] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    out(help());
    return 0;
  }
  if (name === "--version" || name === "-v") {
    out(VERSION);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    err(`Unknown command "${name}".\n\n${help()}`);
    return 2;
  }
  try {
    await command.run(rest);
    return Number(process.exitCode ?? 0);
  } catch (error) {
    const known = error instanceof UserError;
    err(known ? error.message : `Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (name !== "askpass") ctx.log.error("command_failed", { command: name, error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    await ctx.log.flush();
  }
}

const code = await main(process.argv.slice(2));
if (process.argv[2] !== "mcp") process.exit(code);
