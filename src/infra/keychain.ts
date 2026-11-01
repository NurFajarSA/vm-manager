export interface SecretStore {
  get(service: string, account: string): Promise<string | null>;
  has(service: string, account: string): Promise<boolean>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

const ITEM_NOT_FOUND = 44;
const INTERACTIVE_LINE_LIMIT = 4000;

export class KeychainError extends Error {
  override name = "KeychainError";
}

/** The login Keychain through /usr/bin/security. Secrets go in through `security -i` on stdin, never argv. */
export class MacKeychain implements SecretStore {
  async get(service: string, account: string): Promise<string | null> {
    const { code, stdout } = await run(["find-generic-password", "-a", account, "-s", service, "-w"]);
    if (code === ITEM_NOT_FOUND) return null;
    // stderr is left out on purpose: it never holds the secret, but it is not ours to show either.
    if (code !== 0) throw new KeychainError(`Reading the Keychain item for ${account} failed (code ${code}).`);
    return stdout.replace(/\n$/, "");
  }

  async has(service: string, account: string): Promise<boolean> {
    // Without -w, security prints only the item's attributes, so the secret never leaves the Keychain.
    const { code } = await run(["find-generic-password", "-a", account, "-s", service]);
    return code === 0;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const hex = Buffer.from(value, "utf8").toString("hex");
    const line = `add-generic-password -U -a "${account}" -s "${service}" -l "VM Manager: ${account}" -X "${hex}"\n`;
    if (line.length > INTERACTIVE_LINE_LIMIT) throw new KeychainError("That password is too long to store.");
    const result = await run(["-i"], line);
    if (result.code !== 0) throw new KeychainError(`Saving the password for ${account} failed (code ${result.code}).`);
    if (!(await this.has(service, account))) throw new KeychainError(`The password for ${account} was not saved.`);
  }

  async delete(service: string, account: string): Promise<void> {
    const { code } = await run(["delete-generic-password", "-a", account, "-s", service]);
    if (code !== 0 && code !== ITEM_NOT_FOUND) throw new KeychainError(`Removing the password for ${account} failed (code ${code}).`);
  }
}

async function run(args: string[], input?: string) {
  const proc = Bun.spawn(["/usr/bin/security", ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout };
}

export class MemorySecretStore implements SecretStore {
  readonly items = new Map<string, string>();
  private key(service: string, account: string) {
    return `${service}\u0000${account}`;
  }
  async get(service: string, account: string) {
    return this.items.get(this.key(service, account)) ?? null;
  }
  async has(service: string, account: string) {
    return this.items.has(this.key(service, account));
  }
  async set(service: string, account: string, value: string) {
    this.items.set(this.key(service, account), value);
  }
  async delete(service: string, account: string) {
    this.items.delete(this.key(service, account));
  }
}
