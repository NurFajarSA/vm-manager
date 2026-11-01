import { connect } from "node:net";
import { z } from "zod";
import { parseCidr, type Vm } from "../domain/vm.ts";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

export const PROBE_TIMEOUT_MS = 3000;

export const NetworkStateSchema = z.object({
  // `routes` are the subnets from vms.json that were checked. Empty means the VPN subnet is not set, so `up` is unknown and false.
  openvpn: z.object({ up: z.boolean(), interface: z.string().nullable(), via: z.enum(["route", "tunnel"]).nullable(), routes: z.array(z.string()).default([]) }),
  tailscale: z.object({ installed: z.boolean(), running: z.boolean(), tailnet: z.string().nullable() }),
});
export type NetworkState = z.infer<typeof NetworkStateSchema>;

export const ReachabilitySchema = z.enum(["reachable", "needs_vpn", "unreachable"]);
export type Reachability = z.infer<typeof ReachabilitySchema>;

export const StatusReportSchema = z.object({
  checkedAt: z.string(),
  network: NetworkStateSchema,
  vms: z.array(z.object({ name: z.string(), state: ReachabilitySchema, latencyMs: z.number().nullable(), detail: z.string() })),
});
export type StatusReport = z.infer<typeof StatusReportSchema>;

/** Opens a TCP connection and closes it straight away. No ssh, no authentication. */
export function probe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ open: boolean; latencyMs: number | null; error: string | null }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (open: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ open, latencyMs: open ? Math.round(performance.now() - started) : null, error });
    };
    const timer = setTimeout(() => finish(false, "timed out"), timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(false, err.code === "ECONNREFUSED" ? "connection refused" : (err.code ?? err.message)));
  });
}

/** Turns a netstat destination like "10.8/16", "10.8.4" or "10/8" into a network and prefix length. */
export function parseDestination(dest: string): { base: number; prefix: number } | null {
  if (dest === "default") return { base: 0, prefix: 0 };
  const [addr, mask] = dest.split("/");
  if (!addr || !/^\d+(\.\d+){0,3}$/.test(addr)) return null;
  const octets = addr.split(".").map(Number);
  if (octets.some((o) => o > 255)) return null;
  const prefix = mask === undefined ? octets.length * 8 : Number(mask);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  while (octets.length < 4) octets.push(0);
  const base = (((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number)) >>> 0;
  return { base, prefix };
}

function covers(route: { base: number; prefix: number }, network: { base: number; prefix: number }): boolean {
  if (route.prefix > network.prefix) return false;
  const mask = route.prefix === 0 ? 0 : (0xffffffff << (32 - route.prefix)) >>> 0;
  return ((route.base & mask) >>> 0) === ((network.base & mask) >>> 0);
}

/**
 * Finds a route that covers one of the VPN subnets in `netstat -rn -f inet` output. Default and half-default
 * routes (/0, /1) don't count: they belong to whatever full-tunnel VPN is on, not to the OpenVPN profile.
 */
export function findVpnRoute(netstat: string, networks: readonly string[]): { interface: string } | null {
  const targets = networks.map(parseCidr).filter((t): t is { base: number; prefix: number } => t !== null);
  if (targets.length === 0) return null;
  for (const line of netstat.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const route = parseDestination(cols[0] as string);
    if (!route || route.prefix < 8) continue;
    if (targets.some((target) => covers(route, target))) return { interface: cols[3] as string };
  }
  return null;
}

/** The first usable address in a subnet, for asking `route get` which interface would carry it. */
export function probeAddress(network: string): string | null {
  const parsed = parseCidr(network);
  if (!parsed) return null;
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  const first = ((parsed.base & mask) >>> 0) + (parsed.prefix >= 31 ? 0 : 1);
  return [24, 16, 8, 0].map((shift) => (first >>> shift) & 255).join(".");
}

/** The interface `route -n get` picks for an address, from its "interface:" line. */
export function parseRouteGet(output: string): string | null {
  return /^\s*interface:\s*(\S+)/m.exec(output)?.[1] ?? null;
}

export function parseTailscale(json: string): { running: boolean; tailnet: string | null } {
  try {
    const status = JSON.parse(json) as { BackendState?: string; CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null };
    return { running: status.BackendState === "Running", tailnet: status.CurrentTailnet?.Name ?? status.CurrentTailnet?.MagicDNSSuffix ?? null };
  } catch {
    return { running: false, tailnet: null };
  }
}

export function reachability(vm: Pick<Vm, "network">, open: boolean, network: NetworkState): Reachability {
  if (open) return "reachable";
  if (vm.network === "vpn:openvpn" && !network.openvpn.up) return "needs_vpn";
  if (vm.network === "tailscale" && !network.tailscale.running) return "needs_vpn";
  return "unreachable";
}

export type Exec = (cmd: string[]) => Promise<{ code: number; stdout: string }>;

export const exec: Exec = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
};

const TAILSCALE_PATHS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/**
 * OpenVPN counts as connected when this Mac has a route to one of `vpnRoutes`, or when the route to the first of
 * them goes through a utun interface. With no subnets set there is nothing to check, so it reports not connected.
 */
export async function detectNetwork(vpnRoutes: readonly string[], run: Exec = exec, which: (name: string) => string | null = Bun.which): Promise<NetworkState> {
  const routes = [...vpnRoutes];
  let openvpn: NetworkState["openvpn"] = { up: false, interface: null, via: null, routes };
  const address = routes.map(probeAddress).find((a): a is string => a !== null);
  if (address) {
    const [netstat, routeGet] = await Promise.all([run(["/usr/sbin/netstat", "-rn", "-f", "inet"]), run(["/sbin/route", "-n", "get", address])]);
    const route = findVpnRoute(netstat.stdout, routes);
    const tunnel = parseRouteGet(routeGet.stdout);
    if (route) openvpn = { up: true, interface: route.interface, via: "route", routes };
    else if (tunnel?.startsWith("utun")) openvpn = { up: true, interface: tunnel, via: "tunnel", routes };
  }

  const candidates = [which("tailscale"), ...TAILSCALE_PATHS].filter((p): p is string => Boolean(p));
  let tailscale: NetworkState["tailscale"] = { installed: false, running: false, tailnet: null };
  for (const bin of candidates) {
    if (!(await Bun.file(bin).exists())) continue;
    const result = await run([bin, "status", "--json"]);
    tailscale = { installed: true, ...parseTailscale(result.stdout) };
    break;
  }
  return { openvpn, tailscale };
}

export async function checkStatus(
  vms: Vm[],
  { network, probeFn = probe, now = Date.now }: { network: NetworkState; probeFn?: typeof probe; now?: () => number },
): Promise<StatusReport> {
  const rows = await Promise.all(
    vms.map(async (vm) => {
      const result = await probeFn(vm.host, vm.port);
      const state = reachability(vm, result.open, network);
      const detail =
        state === "reachable"
          ? `port ${vm.port} open`
          : state === "needs_vpn"
            ? vm.network === "tailscale"
              ? "connect Tailscale first"
              : network.openvpn.routes.length > 0
                ? "connect OpenVPN first"
                : "connect OpenVPN first (VPN subnet not set)"
            : (result.error ?? "no answer");
      return { name: vm.name, state, latencyMs: result.latencyMs, detail };
    }),
  );
  return { checkedAt: new Date(now()).toISOString(), network, vms: rows };
}

export async function saveStatus(path: string, report: StatusReport): Promise<void> {
  await writeJsonAtomic(path, report);
}

export async function loadStatus(path: string): Promise<StatusReport | null> {
  return readJson(path, StatusReportSchema).catch(() => null);
}
