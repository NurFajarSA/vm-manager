import type { Approval } from "../core/approvals.ts";
import type { AuditEntry } from "../core/audit.ts";
import { identityFile } from "../core/inventory.ts";
import type { StatusReport } from "../core/status.ts";
import type { Vm } from "../domain/vm.ts";
import type { SecretStore } from "../infra/keychain.ts";
import { tildify } from "../infra/paths.ts";

export interface VmRow extends Vm {
  keyMissing: boolean;
  hasPassword: boolean | null;
  sshCommand: string;
}

/** What `vm list --json` gives the app: the inventory plus what can be checked on this Mac. Never a secret. */
export async function toRows(vms: Vm[], { home, secrets, service, sshSynced }: { home: string; secrets: SecretStore; service: string; sshSynced: boolean }): Promise<VmRow[]> {
  return Promise.all(
    vms.map(async (vm) => {
      const key = await identityFile(vm, home);
      const hasPassword = vm.auth.kind === "password" ? await secrets.has(service, vm.name).catch(() => false) : null;
      const viaConfig = sshSynced && vm.active && vm.auth.kind === "key";
      return { ...vm, keyMissing: key !== null && !key.exists, hasPassword, sshCommand: viaConfig ? `ssh ${vm.name}` : `vm ssh ${vm.name}` };
    }),
  );
}

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));

export function paint(color: boolean) {
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), gray: wrap("90") };
}

export function renderList(rows: VmRow[], { color, home, status }: { color: boolean; home: string; status: StatusReport | null }): string {
  const c = paint(color);
  const out: string[] = [];
  const groups = [...new Set(rows.map((r) => r.group))];
  for (const group of groups) {
    out.push(c.bold(group));
    for (const r of rows.filter((x) => x.group === group)) {
      const env = r.env === "prod" ? c.red("PROD") : c.green("DEV ");
      const state = status?.vms.find((s) => s.name === r.name)?.state;
      const dot = !r.active ? c.gray("·") : state === "reachable" ? c.green("●") : state === "needs_vpn" ? c.yellow("●") : state ? c.gray("●") : " ";
      const auth =
        r.auth.kind === "key"
          ? `key ${tildify(r.auth.identityFile, home)}${r.keyMissing ? ` ${c.yellow("⚠ missing")}` : ""}`
          : `password${r.hasPassword ? "" : ` ${c.yellow("⚠ not saved")}`}`;
      out.push(`  ${dot} ${pad(r.name, 24)}${env}  ${pad(`${r.user}@${r.host}${r.port === 22 ? "" : `:${r.port}`}`, 34)}${pad(r.network, 12)}${pad(r.agent, 25)}${auth}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export function renderStatus(report: StatusReport, color: boolean): string {
  const c = paint(color);
  const net = report.network;
  const lines = [
    net.openvpn.routes.length === 0
      ? `OpenVPN: ${c.yellow("VPN subnet not set")}. Run \`vm vpn-routes <subnet>\` (for example 10.8.0.0/16) so VM Manager can tell when the VPN is on.`
      : `OpenVPN (${net.openvpn.routes.join(", ")}): ${net.openvpn.up ? c.green(`connected via ${net.openvpn.interface}`) : c.yellow("not connected")}`,
    `Tailscale: ${!net.tailscale.installed ? "not installed" : net.tailscale.running ? c.green(`running${net.tailscale.tailnet ? ` (${net.tailscale.tailnet})` : ""}`) : c.yellow("stopped")}`,
    "",
  ];
  for (const row of report.vms) {
    const label = row.state === "reachable" ? c.green("reachable  ") : row.state === "needs_vpn" ? c.yellow("needs VPN  ") : c.gray("unreachable");
    lines.push(`${pad(row.name, 26)}${label}  ${row.latencyMs !== null ? `${row.latencyMs} ms` : row.detail}`);
  }
  return lines.join("\n");
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function renderApprovals(approvals: Approval[], color: boolean): string {
  const c = paint(color);
  if (approvals.length === 0) return "No approval requests.";
  return approvals
    .map((a) => {
      const status = a.status === "pending" ? c.yellow("pending") : a.status === "approved" ? c.green("approved") : c.gray(a.status);
      return [
        `${c.bold(a.id)}  ${status}  ${a.vm} (${a.env})  ${ago(a.createdAt)}  from ${a.requester}`,
        `    $ ${a.command}`,
        a.why ? `    why: ${a.why}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export function renderAudit(entries: AuditEntry[], color: boolean): string {
  const c = paint(color);
  if (entries.length === 0) return "Nothing in the audit log yet.";
  return entries
    .map((e) => {
      const decision = ["refused", "denied", "expired"].includes(e.decision) ? c.yellow(e.decision) : e.decision;
      const result = e.exitCode !== null ? ` exit ${e.exitCode}` : "";
      const time = e.durationMs !== null ? ` ${(e.durationMs / 1000).toFixed(1)}s` : "";
      const size = e.outputBytes !== null ? ` ${e.outputBytes}B` : "";
      return `${e.ts.replace("T", " ").slice(0, 19)}  ${pad(e.kind, 8)}${pad(e.vm, 24)}${pad(decision, 10)}${result}${time}${size}  ${e.command}`;
    })
    .join("\n");
}
