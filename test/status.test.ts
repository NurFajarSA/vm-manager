import { describe, expect, test } from "bun:test";
import { checkStatus, detectNetwork, type Exec, findVpnRoute, type NetworkState, parseDestination, parseRouteGet, parseTailscale, probe, probeAddress, reachability } from "../src/core/status.ts";
import { vm } from "./support.ts";

const NETSTAT_VPN = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.1.1        UGScg                 en0
10.20/16           10.8.0.1           UGSc                utun4
127                127.0.0.1          UCS                   lo0
192.168.1          link#14            UCS                   en0      !
`;

const NETSTAT_FULL_TUNNEL = `Destination        Gateway            Flags               Netif Expire
0/1                10.33.0.9          UGScg               utun8
default            192.168.1.1        UGScg                 en0
10.118/16          10.33.0.9          UGSc                utun8
128.0/1            10.33.0.9          UGSc                utun8
`;

const VPN = ["10.20.0.0/16"];

const offline: NetworkState = { openvpn: { up: false, interface: null, via: null, routes: VPN }, tailscale: { installed: true, running: false, tailnet: null } };
const online: NetworkState = { openvpn: { up: true, interface: "utun4", via: "route", routes: VPN }, tailscale: { installed: true, running: true, tailnet: "example.ts.net" } };

describe("network detection", () => {
  test("parses netstat destinations", () => {
    expect(parseDestination("10.20/16")).toEqual({ base: (10 << 24) | (20 << 16), prefix: 16 });
    expect(parseDestination("10.20.4")).toEqual({ base: ((10 << 24) | (20 << 16) | (4 << 8)) >>> 0, prefix: 24 });
    expect(parseDestination("10/8")?.prefix).toBe(8);
    expect(parseDestination("default")).toEqual({ base: 0, prefix: 0 });
    expect(parseDestination("link#14")).toBeNull();
    expect(parseDestination("fe80::1")).toBeNull();
  });

  test("finds a route for one of the configured subnets", () => {
    expect(findVpnRoute(NETSTAT_VPN, VPN)).toEqual({ interface: "utun4" });
    expect(findVpnRoute("10/8  10.8.0.1  UGSc  utun2", VPN)).toEqual({ interface: "utun2" });
    expect(findVpnRoute(NETSTAT_VPN, ["172.16.0.0/12", "10.20.0.0/16"])).toEqual({ interface: "utun4" });
    expect(findVpnRoute(NETSTAT_VPN, ["172.16.0.0/12"])).toBeNull();
  });

  test("no subnet set means no route can match", () => {
    expect(findVpnRoute(NETSTAT_VPN, [])).toBeNull();
    expect(findVpnRoute(NETSTAT_VPN, ["not a subnet"])).toBeNull();
  });

  test("asks route get about the first address of the subnet", () => {
    expect(probeAddress("10.20.0.0/16")).toBe("10.20.0.1");
    expect(probeAddress("192.0.2.77/24")).toBe("192.0.2.1");
    expect(probeAddress("192.0.2.9/32")).toBe("192.0.2.9");
    expect(probeAddress("nope")).toBeNull();
  });

  test("a full-tunnel /1 route or a narrower subnet doesn't count as the VPN route", () => {
    expect(findVpnRoute(NETSTAT_FULL_TUNNEL, VPN)).toBeNull();
    expect(findVpnRoute("10.20.4.8/32  10.8.0.1  UGSc  utun4", VPN)).toBeNull();
  });

  test("reads the interface from route get", () => {
    expect(parseRouteGet("   route to: 10.20.0.1\ndestination: default\n  interface: utun8\n")).toBe("utun8");
    expect(parseRouteGet("route: writing to routing socket: not in table")).toBeNull();
  });

  test("reads Tailscale's state", () => {
    expect(parseTailscale('{"BackendState":"Running","CurrentTailnet":{"Name":"me@example.com"}}')).toEqual({ running: true, tailnet: "me@example.com" });
    expect(parseTailscale('{"BackendState":"Stopped"}')).toEqual({ running: false, tailnet: null });
    expect(parseTailscale("not json")).toEqual({ running: false, tailnet: null });
  });

  test("detectNetwork: route, utun fallback and a missing Tailscale", async () => {
    const calls: string[][] = [];
    const answers = (netstat: string, routeGet: string): Exec => async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: cmd[0]?.endsWith("netstat") ? netstat : routeGet };
    };
    const none = () => null;
    expect((await detectNetwork(VPN, answers(NETSTAT_VPN, ""), none)).openvpn).toEqual({ up: true, interface: "utun4", via: "route", routes: VPN });
    expect(calls).toContainEqual(["/sbin/route", "-n", "get", "10.20.0.1"]);
    expect((await detectNetwork(VPN, answers(NETSTAT_FULL_TUNNEL, "interface: utun8"), none)).openvpn).toEqual({ up: true, interface: "utun8", via: "tunnel", routes: VPN });
    expect((await detectNetwork(VPN, answers("", "interface: en0"), none)).openvpn).toEqual({ up: false, interface: null, via: null, routes: VPN });
  });

  test("detectNetwork without a VPN subnet runs nothing for OpenVPN and reports it unset", async () => {
    const calls: string[][] = [];
    const run: Exec = async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: NETSTAT_VPN };
    };
    expect((await detectNetwork([], run, () => null)).openvpn).toEqual({ up: false, interface: null, via: null, routes: [] });
    expect(calls.filter((cmd) => !cmd[0]?.includes("ailscale"))).toEqual([]);
  });
});

describe("reachability", () => {
  test("an open port is reachable whatever the network", () => {
    expect(reachability({ network: "vpn:openvpn" }, true, offline)).toBe("reachable");
  });

  test("a VPN server with the VPN down needs the VPN", () => {
    expect(reachability({ network: "vpn:openvpn" }, false, offline)).toBe("needs_vpn");
    expect(reachability({ network: "tailscale" }, false, offline)).toBe("needs_vpn");
  });

  test("otherwise it is unreachable", () => {
    expect(reachability({ network: "vpn:openvpn" }, false, online)).toBe("unreachable");
    expect(reachability({ network: "public" }, false, offline)).toBe("unreachable");
  });
});

describe("probe", () => {
  test("an open local port answers", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const result = await probe("127.0.0.1", server.port, 2000);
      expect(result.open).toBe(true);
      expect(result.latencyMs).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("a closed local port is refused", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    const result = await probe("127.0.0.1", port, 2000);
    expect(result).toEqual({ open: false, latencyMs: null, error: "connection refused" });
  });

  test("checkStatus probes every server in parallel", async () => {
    const calls: string[] = [];
    const report = await checkStatus(
      [vm({ name: "a", host: "192.0.2.1" }), vm({ name: "b", host: "192.0.2.2", network: "vpn:openvpn" }), vm({ name: "c", host: "192.0.2.3" })],
      {
        network: offline,
        probeFn: async (host) => {
          calls.push(host);
          await Bun.sleep(50);
          return host.endsWith(".1") ? { open: true, latencyMs: 20, error: null } : { open: false, latencyMs: null, error: "timed out" };
        },
        now: () => Date.parse("2026-11-01T08:00:00Z"),
      },
    );
    expect(calls).toHaveLength(3);
    expect(report.checkedAt).toBe("2026-11-01T08:00:00.000Z");
    expect(report.vms).toEqual([
      { name: "a", state: "reachable", latencyMs: 20, detail: "port 22 open" },
      { name: "b", state: "needs_vpn", latencyMs: null, detail: "connect OpenVPN first" },
      { name: "c", state: "unreachable", latencyMs: null, detail: "timed out" },
    ]);
  });

  test("a VPN server without a VPN subnet says the subnet is not set", async () => {
    const unset: NetworkState = { ...offline, openvpn: { up: false, interface: null, via: null, routes: [] } };
    const report = await checkStatus([vm({ name: "b", host: "192.0.2.2", network: "vpn:openvpn" })], {
      network: unset,
      probeFn: async () => ({ open: false, latencyMs: null, error: "timed out" }),
    });
    expect(report.vms[0]).toMatchObject({ state: "needs_vpn", detail: "connect OpenVPN first (VPN subnet not set)" });
  });
});
