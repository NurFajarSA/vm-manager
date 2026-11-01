import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_BYTES = 5_000_000;

export const AuditEntrySchema = z.object({
  ts: z.string(),
  kind: z.enum(["read", "change", "approval"]),
  vm: z.string(),
  command: z.string(),
  requester: z.string(),
  decision: z.enum(["allowed", "approved", "requested", "refused", "denied", "expired"]),
  reason: z.string().nullable(),
  approvalId: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
  outputBytes: z.number().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditInput = Omit<AuditEntry, "ts" | "reason" | "approvalId" | "exitCode" | "durationMs" | "outputBytes"> &
  Partial<Pick<AuditEntry, "reason" | "approvalId" | "exitCode" | "durationMs" | "outputBytes">>;

/**
 * Credentials people tend to type into commands. The audit log keeps the shape of the command
 * and drops the value. Output never reaches the log at all; only its size does.
 */
export function redact(command: string): string {
  let text = command
    .replace(/(:\/\/[^\s:/@]+:)[^\s@]+@/g, "$1***@")
    .replace(/\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=***")
    .replace(/(--(?:password|passwd|token|secret|api-key))(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1 ***")
    .replace(/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, "$1***");
  if (/\b(mysql|mariadb|mysqldump|mysqladmin)\b/.test(text)) text = text.replace(/(\s-p)([^\s-][^\s]*)/g, "$1***");
  return text;
}

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Appends one line. Writes are serialised so concurrent calls never interleave. */
  record(input: AuditInput): Promise<AuditEntry> {
    const entry: AuditEntry = AuditEntrySchema.parse({
      reason: null,
      approvalId: null,
      exitCode: null,
      durationMs: null,
      outputBytes: null,
      ...input,
      ts: new Date(this.now()).toISOString(),
      command: redact(input.command),
    });
    const line = `${JSON.stringify(entry)}\n`;
    const write = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const size = await stat(this.path).then(
        (s) => s.size,
        () => 0,
      );
      if (size > MAX_BYTES) await rename(this.path, `${this.path}.1`);
      await appendFile(this.path, line, { mode: 0o600 });
    });
    this.chain = write.catch(() => {});
    return write.then(() => entry);
  }

  /** Oldest first; the last `limit` entries. Lines that don't parse are skipped. */
  async read({ limit = 200, vm }: { limit?: number; vm?: string } = {}): Promise<AuditEntry[]> {
    await this.chain;
    const text = await readFile(this.path, "utf8").catch(() => "");
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = AuditEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success && (!vm || parsed.data.vm === vm)) entries.push(parsed.data);
      } catch {
        // a torn line from a crash; skip it
      }
    }
    return entries.slice(-limit);
  }
}
