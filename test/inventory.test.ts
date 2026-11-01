import { describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { InventoryStore } from "../src/core/inventory.ts";
import { EXAMPLE, emptyInventory, exampleInventory, InventorySchema, parseCidr, parseVm, VmSchema } from "../src/domain/vm.ts";
import { resolvePaths } from "../src/infra/paths.ts";
import { tempDir, vm } from "./support.ts";

describe("vms.json schema", () => {
  test("the example is valid, made up, and uses documentation addresses only", () => {
    const inventory = exampleInventory();
    expect(inventory.vms).toHaveLength(9);
    const active = inventory.vms.filter((v) => v.active).map((v) => v.name);
    expect(active).toEqual(["shop-web-prod", "shop-web-dev", "shop-api-dev", "shop-payments-prod", "warehouse", "gpu-train-01", "gpu-lab-02"]);
    const inactive = inventory.vms.filter((v) => !v.active);
    expect(inactive.map((v) => v.host)).toEqual(["198.51.100.50", "192.0.2.60"]);
    expect(inactive.every((v) => v.group === "Inactive" && v.agent === "none")).toBe(true);
    expect(inventory.vms.every((v) => /^(192\.0\.2|198\.51\.100)\.\d+$/.test(v.host))).toBe(true);
    expect(inventory.vms.flatMap((v) => v.aliases).every((a) => a.endsWith(".example.com") || a.endsWith(".example.ts.net"))).toBe(true);
    expect(inventory.networks).toEqual({ openvpn: { routes: ["192.0.2.0/24"] } });
  });

  test("the example matches the table", () => {
    const by = Object.fromEntries(exampleInventory().vms.map((v) => [v.name, v]));
    expect(by["shop-api-dev"]).toMatchObject({ env: "dev", host: "192.0.2.41", user: "alex", network: "vpn:openvpn", agent: "free", auth: { kind: "key", identityFile: "~/.ssh/id_ed25519_shop" } });
    expect(by["shop-payments-prod"]).toMatchObject({ aliases: ["pay.example.com"], auth: { kind: "key", identityFile: "~/.ssh/payments_ed25519" } });
    expect(by["shop-web-dev"]).toMatchObject({ auth: { kind: "password" }, network: "vpn:openvpn", agent: "free" });
    expect(by["gpu-train-01"]).toMatchObject({ user: "lab", group: "GPU", agent: "read-free-change-approve" });
    expect(Object.values(by).filter((v) => v.env === "prod" && v.active).every((v) => v.agent === "read-free-change-approve")).toBe(true);
  });

  test("an empty inventory has no servers and no VPN subnet", () => {
    expect(emptyInventory()).toEqual({ version: 1, vms: [] });
  });

  test("defaults fill port, aliases, notes, network and active", () => {
    const parsed = parseVm({ name: "x", group: "G", env: "dev", host: "192.0.2.1", user: "u", auth: { kind: "password" } });
    expect(parsed).toMatchObject({ port: 22, aliases: [], notes: "", network: "public", active: true, agent: "read-free-change-approve" });
  });

  test.each([
    ["name with spaces", { name: "web prod" }],
    ["upper-case name", { name: "Web" }],
    ["host that is an ssh option", { host: "-oProxyCommand=touch /tmp/x" }],
    ["host with a newline", { host: "192.0.2.1\nHost *" }],
    ["host with a space", { host: "192.0.2.1 evil" }],
    ["user with a newline", { user: "deploy\n  ProxyCommand x" }],
    ["user that is an option", { user: "-oX" }],
    ["identity file that is an option", { auth: { kind: "key", identityFile: "-oProxyCommand=x" } }],
    ["identity file with a newline", { auth: { kind: "key", identityFile: "~/.ssh/id\nHost *" } }],
    ["identity file with a quote", { auth: { kind: "key", identityFile: '~/.ssh/id"x' } }],
    ["unknown auth", { auth: { kind: "token" } }],
    ["port out of range", { port: 70000 }],
    ["unknown env", { env: "staging" }],
    ["unknown network", { network: "wireguard" }],
    ["unknown policy", { agent: "yolo" }],
    ["alias with a space", { aliases: ["a b"] }],
  ])("rejects a %s", (_label, override) => {
    expect(VmSchema.safeParse({ ...vm(), ...override }).success).toBe(false);
  });

  test("duplicate names are rejected", () => {
    const one = vm();
    expect(InventorySchema.safeParse({ version: 1, vms: [one, one] }).success).toBe(false);
  });

  test("the example has no passwords in it", () => {
    expect(JSON.stringify(EXAMPLE)).not.toMatch(/"password"\s*:\s*"/);
  });

  test.each([
    ["10.8.0.0/16", { base: (10 << 24) | (8 << 16), prefix: 16 }],
    ["192.0.2.0/24", { base: ((192 << 24) | (2 << 8)) >>> 0, prefix: 24 }],
    [" 172.16.0.0/12 ", { base: ((172 << 24) | (16 << 16)) >>> 0, prefix: 12 }],
  ])("parses the subnet %s", (value, expected) => {
    expect(parseCidr(value)).toEqual(expected);
  });

  test.each(["10.8.0.0", "10.8/16", "10.8.0.0/7", "0.0.0.0/0", "10.8.0.0/33", "256.1.1.1/24", "fe80::/10", "10.8.0.0/16; reboot"])("refuses the subnet %s", (value) => {
    expect(parseCidr(value)).toBeNull();
    expect(InventorySchema.safeParse({ version: 1, networks: { openvpn: { routes: [value] } }, vms: [] }).success).toBe(false);
  });
});

describe("inventory store", () => {
  async function store() {
    const home = await tempDir();
    const paths = resolvePaths({ HOME: home });
    return { store: new InventoryStore(paths), paths };
  }

  test("init writes an empty list once and never overwrites", async () => {
    const { store: s, paths } = await store();
    expect(await s.init()).toEqual({ created: true, count: 0 });
    expect((await stat(paths.vmsFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.vmsFile, "utf8"))).toEqual({ version: 1, vms: [] });
    await s.put(vm({ name: "extra" }));
    expect(await s.init()).toEqual({ created: false, count: 1 });
    expect(await s.init({ example: true })).toEqual({ created: false, count: 1 });
    expect((await s.list()).map((v) => v.name)).toEqual(["extra"]);
  });

  test("init --example writes the made-up list, and only into an empty spot", async () => {
    const { store: s } = await store();
    expect(await s.init({ example: true })).toEqual({ created: true, count: 9 });
    expect(await s.vpnRoutes()).toEqual(["192.0.2.0/24"]);
    expect(await s.init()).toEqual({ created: false, count: 9 });
  });

  test("VPN subnets: unset on an old file, set, kept through edits, cleared", async () => {
    const { store: s, paths } = await store();
    // A vms.json from before VPN subnets were configurable has no networks key.
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.vmsFile, JSON.stringify({ version: 1, vms: [vm({ name: "old" })] }));
    expect(await s.vpnRoutes()).toEqual([]);
    expect(await s.setVpnRoutes(["10.8.0.0/16", "172.16.0.0/12", "10.8.0.0/16"])).toEqual(["10.8.0.0/16", "172.16.0.0/12"]);
    await s.put(vm({ name: "new", network: "vpn:openvpn" }));
    await s.put({ ...(await s.get("old")), notes: "edited" }, { replacing: "old" });
    await s.remove("new");
    expect(JSON.parse(await readFile(paths.vmsFile, "utf8")).networks).toEqual({ openvpn: { routes: ["10.8.0.0/16", "172.16.0.0/12"] } });
    await expect(s.setVpnRoutes(["10.8.0.0"])).rejects.toThrow("10.8.0.0: Use an IPv4 network");
    expect(await s.setVpnRoutes([])).toEqual([]);
    expect(JSON.parse(await readFile(paths.vmsFile, "utf8"))).not.toHaveProperty("networks");
  });

  test("load explains a missing or broken file", async () => {
    const { store: s, paths } = await store();
    await expect(s.load()).rejects.toThrow("vm init");
    await s.init({ example: true });
    await writeFile(paths.vmsFile, '{"version":1,"vms":[{"name":"Bad Name"}]}');
    await expect(s.load()).rejects.toThrow("is not valid");
  });

  test("put adds, replaces and renames; remove deletes", async () => {
    const { store: s, paths } = await store();
    await s.init({ example: true });
    await expect(s.put(vm({ name: "shop-api-dev" }))).rejects.toThrow("already exists");
    await s.put({ ...(await s.get("shop-api-dev")), name: "shop-api-staging" }, { replacing: "shop-api-dev" });
    expect((await s.list()).map((v) => v.name)).toContain("shop-api-staging");
    expect((await s.list()).map((v) => v.name)).not.toContain("shop-api-dev");
    await s.remove("shop-api-staging");
    expect(JSON.parse(await readFile(paths.vmsFile, "utf8")).vms).toHaveLength(8);
  });

  test("get finds a server by name, alias or address", async () => {
    const { store: s } = await store();
    await s.init({ example: true });
    expect((await s.get("pay.example.com")).name).toBe("shop-payments-prod");
    expect((await s.get("198.51.100.40")).name).toBe("gpu-train-01");
    await expect(s.get("nope")).rejects.toThrow("No server named");
  });

  test("put rejects invalid input with a readable message", async () => {
    const { store: s } = await store();
    await s.init({ example: true });
    await expect(s.put({ ...vm(), host: "-oProxyCommand=x" })).rejects.toThrow("host:");
  });
});
