import { z } from "zod";

// Every field here ends up in ssh argv or ~/.ssh/config, so the patterns are strict on purpose:
// no whitespace, no newlines, no quotes, and nothing that starts with "-" and could be read as an ssh option.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const PATH = /^[^\s"'\\\0-\x1f-][^"'\\\0-\x1f]*$/;
const GROUP = /^[^\0-\x1f]{1,40}$/;

export const VmName = z.string().regex(NAME, "Use lowercase letters, digits and dashes, like shop-web-prod.");
export const Hostname = z.string().regex(HOST, "Use an IP address or a hostname.");

export const Auth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), identityFile: z.string().regex(PATH, "Use a plain file path, like ~/.ssh/id_ed25519.") }),
  z.object({ kind: z.literal("password") }),
]);
export type Auth = z.infer<typeof Auth>;

export const ENVS = ["prod", "dev"] as const;
export const NETWORKS = ["public", "vpn:openvpn", "tailscale"] as const;
export const AGENT_POLICIES = ["free", "read-free-change-approve", "none"] as const;

export const Env = z.enum(ENVS);
export const Network = z.enum(NETWORKS);
export const AgentPolicy = z.enum(AGENT_POLICIES);
export type Env = z.infer<typeof Env>;
export type Network = z.infer<typeof Network>;
export type AgentPolicy = z.infer<typeof AgentPolicy>;

export const VmSchema = z.object({
  name: VmName,
  group: z.string().regex(GROUP, "Use a short group name."),
  env: Env,
  host: Hostname,
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().regex(USER, "Use a plain Unix user name."),
  auth: Auth,
  network: Network.default("public"),
  aliases: z.array(Hostname).default([]),
  notes: z.string().max(2000).default(""),
  agent: AgentPolicy.default("read-free-change-approve"),
  active: z.boolean().default(true),
});
export type Vm = z.infer<typeof VmSchema>;
export type VmInput = z.input<typeof VmSchema>;

/** An IPv4 network such as 10.8.0.0/16. A prefix shorter than /8 would match nearly any route, so it is refused. */
export function parseCidr(value: string): { base: number; prefix: number } | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((o) => o > 255) || prefix < 8 || prefix > 32) return null;
  const base = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0);
  return { base, prefix };
}

export const Cidr = z
  .string()
  .trim()
  .refine((value) => parseCidr(value) !== null, "Use an IPv4 network with a prefix from /8 to /32, like 10.8.0.0/16.");

/**
 * Networks VM Manager checks for. `openvpn.routes` are the subnets your OpenVPN profile routes; the VPN counts as
 * connected when this Mac has a route to one of them. There is no default: every VPN uses its own subnets.
 */
export const NetworksSchema = z.object({
  openvpn: z.object({ routes: z.array(Cidr).max(32) }).optional(),
});
export type Networks = z.infer<typeof NetworksSchema>;

export const InventorySchema = z
  .object({ version: z.literal(1), networks: NetworksSchema.optional(), vms: z.array(VmSchema) })
  .superRefine((inventory, ctx) => {
    const seen = new Set<string>();
    for (const [i, vm] of inventory.vms.entries()) {
      if (seen.has(vm.name)) ctx.addIssue({ code: "custom", path: ["vms", i, "name"], message: `Two servers are named ${vm.name}.` });
      seen.add(vm.name);
    }
  });
export type Inventory = z.infer<typeof InventorySchema>;

export const POLICY_LABELS: Record<AgentPolicy, string> = {
  free: "Run anything",
  "read-free-change-approve": "Read freely, ask before changes",
  none: "No agent access",
};

const key = (identityFile: string) => ({ kind: "key" as const, identityFile });
const password = { kind: "password" as const };

/**
 * The made-up servers `vm init --example` writes, to show what a filled-in list looks like.
 * Addresses are from the documentation ranges (192.0.2.0/24, 198.51.100.0/24), so none of them is a real host.
 */
export const EXAMPLE: VmInput[] = [
  {
    name: "shop-web-prod",
    group: "Shop",
    env: "prod",
    host: "198.51.100.20",
    aliases: ["shop.example.com"],
    user: "deploy",
    auth: password,
    network: "public",
    agent: "read-free-change-approve",
    notes: "Storefront. App in /srv/shop, started with docker compose.",
  },
  {
    name: "shop-web-dev",
    group: "Shop",
    env: "dev",
    host: "192.0.2.40",
    aliases: ["dev.shop.example.com"],
    user: "deploy",
    auth: password,
    network: "vpn:openvpn",
    agent: "free",
  },
  {
    name: "shop-api-dev",
    group: "Shop",
    env: "dev",
    host: "192.0.2.41",
    user: "alex",
    auth: key("~/.ssh/id_ed25519_shop"),
    network: "vpn:openvpn",
    agent: "free",
  },
  {
    name: "shop-payments-prod",
    group: "Shop",
    env: "prod",
    host: "198.51.100.21",
    aliases: ["pay.example.com"],
    user: "alex",
    auth: key("~/.ssh/payments_ed25519"),
    network: "public",
    agent: "read-free-change-approve",
  },
  {
    name: "warehouse",
    group: "Data",
    env: "prod",
    host: "198.51.100.30",
    aliases: ["warehouse.example.ts.net"],
    user: "alex",
    auth: key("~/.ssh/id_ed25519"),
    network: "public",
    agent: "read-free-change-approve",
    notes: "Postgres 16 and the nightly import jobs.",
  },
  {
    name: "gpu-train-01",
    group: "GPU",
    env: "prod",
    host: "198.51.100.40",
    user: "lab",
    auth: password,
    network: "public",
    agent: "read-free-change-approve",
    notes: "4× A100. Ask before stopping jobs.",
  },
  {
    name: "gpu-lab-02",
    group: "GPU",
    env: "prod",
    host: "198.51.100.41",
    user: "student01",
    auth: password,
    network: "public",
    agent: "read-free-change-approve",
  },
  ...[
    { host: "198.51.100.50", user: "deploy", auth: password },
    { host: "192.0.2.60", user: "alex", auth: key("~/.ssh/id_ed25519") },
  ].map((vm) => ({
    ...vm,
    name: `inactive-${vm.host.replaceAll(".", "-")}`,
    group: "Inactive",
    env: "prod" as const,
    network: "public" as const,
    agent: "none" as const,
    active: false,
    notes: "No longer in use. Kept so the address is not forgotten.",
  })),
];

/** What `vm init` writes: no servers, and no VPN subnet until you set one. */
export function emptyInventory(): Inventory {
  return InventorySchema.parse({ version: 1, vms: [] });
}

/** What `vm init --example` writes: the made-up servers above, with their VPN subnet. */
export function exampleInventory(): Inventory {
  return InventorySchema.parse({ version: 1, networks: { openvpn: { routes: ["192.0.2.0/24"] } }, vms: EXAMPLE });
}

export function parseVm(input: unknown): Vm {
  return VmSchema.parse(input);
}

/** The first problem zod found, phrased for a person. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid value.";
  const where = issue.path.filter((p) => typeof p === "string").join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}
