import { stat } from "node:fs/promises";
import { z } from "zod";
import { Cidr, describeIssue, emptyInventory, exampleInventory, type Inventory, InventorySchema, type Vm, VmSchema } from "../domain/vm.ts";
import { readJson, writeJsonAtomic } from "../infra/files.ts";
import { withLock } from "../infra/lock.ts";
import { expandHome, type Paths } from "../infra/paths.ts";
import { UserError } from "./errors.ts";

/** vms.json: the list of servers. Every write is validated, locked and atomic. */
export class InventoryStore {
  constructor(private readonly paths: Paths) {}

  async exists(): Promise<boolean> {
    return stat(this.paths.vmsFile).then(
      () => true,
      () => false,
    );
  }

  async load(): Promise<Inventory> {
    let inventory: Inventory | null;
    try {
      inventory = await readJson(this.paths.vmsFile, InventorySchema);
    } catch (err) {
      if (err instanceof z.ZodError) throw new UserError(`${this.paths.vmsFile} is not valid: ${describeIssue(err)}`);
      if (err instanceof SyntaxError) throw new UserError(`${this.paths.vmsFile} is not valid JSON: ${err.message}`);
      throw err;
    }
    if (!inventory) throw new UserError("No servers yet. Run `vm init` to create the inventory.");
    return inventory;
  }

  async list(): Promise<Vm[]> {
    return (await this.load()).vms;
  }

  async get(name: string): Promise<Vm> {
    const vms = await this.list();
    const vm = vms.find((v) => v.name === name) ?? vms.find((v) => v.aliases.includes(name) || v.host === name);
    if (!vm) throw new UserError(`No server named "${name}". See \`vm list\`.`);
    return vm;
  }

  /** Writes an empty list (or, with `example`, the made-up example), but only when there is no inventory yet. */
  async init({ example = false }: { example?: boolean } = {}): Promise<{ created: boolean; count: number }> {
    return withLock(this.paths.lockDir, async () => {
      if (await this.exists()) return { created: false, count: (await this.load()).vms.length };
      const inventory = example ? exampleInventory() : emptyInventory();
      await writeJsonAtomic(this.paths.vmsFile, inventory);
      return { created: true, count: inventory.vms.length };
    });
  }

  /** The subnets that count as the OpenVPN connection. Empty until the user sets them. */
  async vpnRoutes(): Promise<string[]> {
    return (await this.load()).networks?.openvpn?.routes ?? [];
  }

  /** Replaces the OpenVPN subnets. An empty list removes the setting. */
  async setVpnRoutes(routes: string[]): Promise<string[]> {
    const parsed = routes.map((route) => {
      const result = Cidr.safeParse(route);
      if (!result.success) throw new UserError(`${route}: ${describeIssue(result.error)}`);
      return result.data;
    });
    const unique = [...new Set(parsed)];
    return withLock(this.paths.lockDir, async () => {
      const { networks: _previous, ...inventory } = await this.load();
      await this.write(unique.length > 0 ? { ...inventory, networks: { openvpn: { routes: unique } } } : inventory);
      return unique;
    });
  }

  /** Adds a server, or replaces the one called `replacing` (which may be its old name). */
  async put(input: unknown, { replacing }: { replacing?: string } = {}): Promise<Vm> {
    const parsed = VmSchema.safeParse(input);
    if (!parsed.success) throw new UserError(describeIssue(parsed.error));
    const vm = parsed.data;
    return withLock(this.paths.lockDir, async () => {
      const inventory = await this.load();
      const index = replacing ? inventory.vms.findIndex((v) => v.name === replacing) : -1;
      if (replacing && index < 0) throw new UserError(`No server named "${replacing}".`);
      if (inventory.vms.some((v, i) => v.name === vm.name && i !== index)) throw new UserError(`A server named ${vm.name} already exists.`);
      const vms = [...inventory.vms];
      if (index >= 0) vms[index] = vm;
      else vms.push(vm);
      await this.write({ ...inventory, vms });
      return vm;
    });
  }

  async remove(name: string): Promise<Vm> {
    return withLock(this.paths.lockDir, async () => {
      const inventory = await this.load();
      const vm = inventory.vms.find((v) => v.name === name);
      if (!vm) throw new UserError(`No server named "${name}".`);
      await this.write({ ...inventory, vms: inventory.vms.filter((v) => v !== vm) });
      return vm;
    });
  }

  /** Validates the whole file before it replaces the old one, and keeps every setting next to the servers. */
  private async write(inventory: Inventory): Promise<void> {
    await writeJsonAtomic(this.paths.vmsFile, InventorySchema.parse(inventory));
  }
}

/** The identity file a key server uses, with ~ expanded, and whether it is on disk. */
export async function identityFile(vm: Vm, home: string): Promise<{ path: string; exists: boolean } | null> {
  if (vm.auth.kind !== "key") return null;
  const path = expandHome(vm.auth.identityFile, home);
  const exists = await stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
  return { path, exists };
}
