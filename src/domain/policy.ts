import type { AgentPolicy } from "./vm.ts";

/**
 * The policy engine. Pure functions only: no I/O, no clock, so every rule is covered by unit tests.
 *
 * A command is read-only when it has no shell metacharacters and its first word (plus subcommand,
 * where the tool has one) is on the allowlist below. Anything else is a change. The blocklist is a
 * backstop for a few catastrophic commands and applies even when the user approves; the approval
 * itself is the real control, because no list can recognise every way to write a shell command.
 */

export const METACHARACTERS = [";", "|", "&", ">", "<", "$", "(", ")", "`", "\\", "\n", "\r"] as const;

export type Classification = { readOnly: true } | { readOnly: false; reason: string };

type Rule = (args: string[]) => string | null;

const anything: Rule = () => null;

const rejectFlags =
  (flags: string[], prefixes: string[] = []): Rule =>
  (args) => {
    const bad = args.find((a) => flags.includes(a) || prefixes.some((p) => a.startsWith(p)));
    return bad ? `\`${bad}\` can change things` : null;
  };

const subcommands =
  (allowed: Record<string, Rule>): Rule =>
  (args) => {
    const [sub, ...rest] = args;
    if (sub === undefined) return "needs a subcommand";
    const rule = Object.hasOwn(allowed, sub) ? allowed[sub] : undefined;
    if (!rule) return `\`${sub}\` is not a read-only subcommand`;
    return rule(rest);
  };

/** Options are skipped (those in `valueFlags` with their value); the first other word must be an allowed verb. */
const verb =
  (verbs: string[], { valueFlags = [], rejected = [] }: { valueFlags?: string[]; rejected?: string[] } = {}): Rule =>
  (args) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (rejected.some((r) => a === r || a.startsWith(`${r}=`))) return `\`${a}\` is not allowed here`;
      if (a.startsWith("-")) {
        if (valueFlags.includes(a)) i++;
        continue;
      }
      return verbs.includes(a) ? null : `\`${a}\` is not a read-only subcommand`;
    }
    return "needs a subcommand";
  };

const COMPOSE: Rule = verb(["ps", "logs", "ls", "images", "top"], {
  valueFlags: ["-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile"],
});

const TOP: Rule = (args) => {
  const joined = args.join(" ");
  const batch = /(^| )-b( |$)|(^| )-bn ?1( |$)/.test(joined);
  const once = /(^| )-n ?1( |$)|(^| )-bn ?1( |$)/.test(joined);
  const known = args.every((a) => ["-b", "-n", "1", "-n1", "-bn1", "-bn", "-c", "-w"].includes(a));
  return batch && once && known ? null : "only `top -b -n1` runs once and exits";
};

const LESS: Rule = (args) => {
  const option = args.find((a) => a.startsWith("-") || a.startsWith("+"));
  return option ? `\`less\` options like \`${option}\` are not allowed; use cat, head or tail` : null;
};

const CURL_FLAGS = new Set(["-I", "--head", "-s", "--silent", "-S", "--show-error", "-L", "--location", "-k", "--insecure", "-v", "--verbose", "-i", "--include"]);
const CURL_VALUE_FLAGS = new Set(["-m", "--max-time", "--connect-timeout", "-H", "--header", "-A", "--user-agent"]);
const CURL: Rule = (args) => {
  let head = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (CURL_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (CURL_FLAGS.has(a) || /^-[IsSLkvi]+$/.test(a)) {
      if (a === "--head" || (/^-[a-zA-Z]+$/.test(a) && a.includes("I"))) head = true;
      continue;
    }
    if (/^https?:\/\/\S+$/.test(a)) continue;
    return `\`${a}\` is not allowed with curl; only \`curl -I <url>\` is read-only`;
  }
  return head ? null : "only `curl -I` (headers only) is read-only";
};

const IP_OPTIONS = new Set(["-4", "-6", "-s", "-stats", "-d", "-details", "-br", "-brief", "-c", "-color", "-j", "-json", "-p", "-pretty", "-o", "-oneline", "-h", "-human"]);
const IP_OBJECTS = new Set(["a", "addr", "address", "r", "ro", "route", "l", "link", "n", "neigh", "neighbour"]);
const IP_CHANGES = new Set(["add", "del", "delete", "change", "replace", "set", "flush", "append", "prepend", "save", "restore", "up", "down"]);
const IP: Rule = (args) => {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    if (!IP_OPTIONS.has(args[i] as string)) return `\`${args[i]}\` is not allowed with ip`;
    i++;
  }
  const object = args[i];
  if (!object || !IP_OBJECTS.has(object)) return "only `ip a`, `ip route`, `ip link` and `ip neigh` are read-only";
  const change = args.slice(i + 1).find((a) => IP_CHANGES.has(a));
  return change ? `\`ip ${object} ${change}\` changes the network` : null;
};

const HOSTNAME_FLAGS = new Set(["-I", "-i", "-f", "-s", "-d", "-A", "-a", "--fqdn", "--long", "--short", "--domain", "--all-ip-addresses", "--ip-address", "--all-fqdns", "--alias"]);
const HOSTNAME: Rule = (args) => {
  const bad = args.find((a) => !HOSTNAME_FLAGS.has(a));
  return bad ? `\`hostname ${bad}\` can rename the server` : null;
};

const NVIDIA_FLAGS = new Set(["-L", "--list-gpus", "-q", "--query", "-x", "--xml-format"]);
const NVIDIA_VALUE_FLAGS = new Set(["-i", "--id", "-d", "--display"]);
const NVIDIA: Rule = (args) => {
  if (args[0] === "topo") return args.slice(1).every((a) => a === "-m" || a === "--matrix") ? null : "only `nvidia-smi topo -m` is read-only";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (NVIDIA_FLAGS.has(a) || /^--(query-gpu|query-compute-apps|format|id|display)=/.test(a)) continue;
    if (NVIDIA_VALUE_FLAGS.has(a) && args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("-")) {
      i++;
      continue;
    }
    return `\`nvidia-smi ${a}\` is not on the read-only list`;
  }
  return null;
};

const SS: Rule = (args) => {
  const bad = args.find((a) => a === "--kill" || a.startsWith("--diag") || (/^-[a-zA-Z]+$/.test(a) && /[KD]/.test(a)));
  return bad ? `\`ss ${bad}\` can close sockets or write files` : null;
};

const FIND = rejectFlags(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

const JOURNALCTL = rejectFlags(
  ["--rotate", "--flush", "--sync", "--relinquish-var", "--smart-relinquish-var", "--setup-keys", "--update-catalog"],
  ["--vacuum", "--cursor-file"],
);

const GIT_NO_WRITE = rejectFlags(["--ext-diff", "-o"], ["--output"]);

const SYSTEMCTL = verb(["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "show"], {
  rejected: ["-H", "--host", "-M", "--machine"],
});

/** First word → rule for the rest. A command whose first word is missing here is a change. */
export const READ_ONLY: Record<string, Rule> = {
  cat: anything,
  head: anything,
  tail: anything,
  less: LESS,
  ls: anything,
  df: anything,
  du: anything,
  free: anything,
  uptime: anything,
  whoami: anything,
  id: anything,
  uname: anything,
  pwd: anything,
  nproc: anything,
  lsblk: anything,
  wc: anything,
  stat: anything,
  w: anything,
  who: anything,
  hostname: HOSTNAME,
  ps: anything,
  top: TOP,
  grep: anything,
  find: FIND,
  ss: SS,
  netstat: anything,
  ip: IP,
  curl: CURL,
  "nvidia-smi": NVIDIA,
  journalctl: JOURNALCTL,
  systemctl: SYSTEMCTL,
  docker: subcommands({
    ps: anything,
    logs: anything,
    inspect: anything,
    images: anything,
    top: anything,
    version: anything,
    info: anything,
    stats: (args) => (args.includes("--no-stream") ? null : "`docker stats` needs --no-stream"),
    compose: COMPOSE,
  }),
  "docker-compose": COMPOSE,
  git: subcommands({ status: GIT_NO_WRITE, log: GIT_NO_WRITE, diff: GIT_NO_WRITE, show: GIT_NO_WRITE }),
};

/** The allowlist in words, for `vm policy` and the app. */
export const READ_ONLY_SUMMARY = [
  "cat, head, tail, less, ls, wc, stat, grep",
  "df, du, free, uptime, whoami, id, uname, hostname, nproc, lsblk, w, who, ps, top -b -n1",
  "find (without -exec or -delete)",
  "journalctl (without --vacuum or --rotate)",
  "systemctl status, is-active, is-enabled, is-failed, list-units, list-timers, show",
  "docker ps, logs, inspect, images, top, version, info, stats --no-stream",
  "docker compose ps, logs, ls, images, top",
  "git status, log, diff, show",
  "ss, netstat, ip a, ip route, curl -I, nvidia-smi",
];

/** Splits a metacharacter-free command into words, honouring single and double quotes. */
export function words(command: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(current);
  return out;
}

export function classify(command: string): Classification {
  const trimmed = command.trim();
  if (!trimmed) return { readOnly: false, reason: "the command is empty" };
  const meta = METACHARACTERS.find((m) => trimmed.includes(m));
  if (meta) return { readOnly: false, reason: `it contains the shell character ${JSON.stringify(meta)}` };
  if (/[\0-\x08\x0b-\x1f\x7f]/.test(trimmed)) return { readOnly: false, reason: "it contains a control character" };
  // The remote shell splits words on spaces and tabs only; any other blank would make it see a different command than we do.
  if (/[\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(trimmed)) {
    return { readOnly: false, reason: "it contains a Unicode space" };
  }
  const parts = words(trimmed);
  if (!parts) return { readOnly: false, reason: "it has an unclosed quote" };
  const [first, ...args] = parts;
  if (!first) return { readOnly: false, reason: "the command is empty" };
  const rule = Object.hasOwn(READ_ONLY, first) ? READ_ONLY[first] : undefined;
  if (!rule) return { readOnly: false, reason: `\`${first}\` is not on the read-only list` };
  const problem = rule(args);
  return problem ? { readOnly: false, reason: problem } : { readOnly: true };
}

// ---------------------------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------------------------

export type Block = { kind: "hard" | "destructive"; rule: string };

export const HARD_BLOCKS = ["rm -rf /", "rm -rf /*", "mkfs", "dd of=/dev/", "shutdown", "reboot", "poweroff", "halt", ":(){ (fork bomb)"];
export const DESTRUCTIVE = ["DROP DATABASE", "DROP SCHEMA", "DROP TABLE", "TRUNCATE"];

/** Commands that run the command after them; the value lists the options that take an argument. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"],
  doas: ["-u", "-C"],
  env: ["-u", "--unset", "-C", "--chdir"],
  nohup: [],
  time: [],
  command: [],
  exec: [],
  builtin: [],
  setsid: [],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-I", "-d", "-n", "-P", "-L", "-s", "-a", "-E", "--delimiter", "--max-args", "--max-procs", "--arg-file"],
  watch: ["-n", "--interval"],
  sh: [],
  bash: [],
  zsh: [],
  dash: [],
  ksh: [],
  su: ["-c", "-s", "--command", "--shell"],
};

const POWER = new Set(["shutdown", "reboot", "poweroff", "halt"]);

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * Every simple command in the text, as words. Quotes and backslashes are dropped first, so
 * "re""boot", 're'boot and re\boot all read as reboot, and "$(reboot)" splits like $(reboot).
 * Splitting too eagerly only means blocking more, which is the safe direction for a blocklist.
 */
export function simpleCommands(command: string): string[][] {
  const flat = command
    .replace(/["'\\]/g, "")
    .replace(/\$\{?IFS\}?/g, " ");
  return flat
    .split(/[;&|\n\r()`{}]/)
    .map((segment) => segment.split(/\s+/).filter((w) => w && w !== "$" && w !== "!"))
    .filter((segment) => segment.length > 0);
}

/** Drops wrappers like sudo, env, nohup, timeout 5 and bash -c, and VAR=value prefixes. */
export function unwrap(segment: string[]): string[] {
  let rest = segment;
  for (let guard = 0; guard < 16 && rest.length > 0; guard++) {
    const head = rest[0] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      rest = rest.slice(1);
      continue;
    }
    const name = basename(head);
    const valueFlags = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (!valueFlags) break;
    let i = 1;
    while (i < rest.length) {
      const word = rest[i] as string;
      if (word === "--") {
        i++;
        break;
      }
      if (!word.startsWith("-") && !(name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) break;
      i += valueFlags.includes(word) ? 2 : 1;
    }
    // timeout takes a duration before the command; su -c's value is the command itself.
    if (name === "timeout" && i < rest.length && /^\d/.test(rest[i] as string)) i++;
    if (name === "su") {
      const c = rest.findIndex((w) => w === "-c" || w === "--command");
      if (c >= 0) i = c + 1;
    }
    rest = rest.slice(i);
  }
  return rest;
}

const isRootTarget = (word: string) => /^\/+(?:\.{1,2}\/*)*\*?$/.test(word);
const isRecursiveFlag = (word: string) => word === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word);

function hardRule(parts: string[]): string | null {
  const [head, ...args] = parts;
  if (!head) return null;
  const name = basename(head);
  if (name === "rm") {
    if (args.includes("--no-preserve-root")) return "rm -rf /";
    if (args.some(isRecursiveFlag)) {
      const target = args.find(isRootTarget);
      if (target) return target.endsWith("*") ? "rm -rf /*" : "rm -rf /";
    }
  }
  if (name === "find") {
    const exec = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
    if (exec >= 0) return hardRule(unwrap(args.slice(exec + 1)));
  }
  if (name.startsWith("mkfs") || name === "mke2fs") return "mkfs";
  if (name === "dd" && args.some((a) => /^of=\/dev\/(?!null$)/.test(a))) return "dd of=/dev/";
  if (POWER.has(name)) return name;
  if (name === "systemctl") {
    const action = args.find((a) => !a.startsWith("-"));
    if (action && ["reboot", "poweroff", "halt", "kexec", "soft-reboot"].includes(action)) return action === "poweroff" || action === "halt" ? action : "reboot";
  }
  if ((name === "init" || name === "telinit") && (args[0] === "0" || args[0] === "6")) return args[0] === "0" ? "poweroff" : "reboot";
  return null;
}

export function checkBlocklist(command: string): Block | null {
  if (/:\s*\(\s*\)\s*\{/.test(command) || /\b(\w+)\s*\(\s*\)\s*\{[^}]*\b\1\s*\|\s*\1\b/.test(command)) return { kind: "hard", rule: ":(){ (fork bomb)" };
  const unquoted = command.replace(/["'\\]/g, "");
  if (/\bof=\/dev\/(?!null\b)/.test(unquoted) && /\bdd\b/.test(unquoted)) return { kind: "hard", rule: "dd of=/dev/" };
  if (/\/proc\/sysrq-trigger/.test(unquoted)) return { kind: "hard", rule: "reboot" };
  for (const segment of simpleCommands(command)) {
    const rule = hardRule(unwrap(segment));
    if (rule) return { kind: "hard", rule };
  }
  const flat = command.replace(/["'`\\]/g, "").replace(/\s+/g, " ");
  const sql = /\bdrop\s+(database|schema|table)\b/i.exec(flat);
  if (sql) return { kind: "destructive", rule: `DROP ${(sql[1] as string).toUpperCase()}` };
  if (/\btruncate\b/i.test(flat)) return { kind: "destructive", rule: "TRUNCATE" };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------

export type Tool = "read" | "change";

export type Decision =
  | { kind: "run"; readOnly: boolean; reason: string }
  | { kind: "approve"; reason: string }
  | { kind: "refuse"; reason: string };

export const MAX_COMMAND_LENGTH = 8000;

export function decide({
  command,
  policy,
  tool,
  confirmDestructive = false,
}: {
  command: string;
  policy: AgentPolicy;
  tool: Tool;
  confirmDestructive?: boolean;
}): Decision {
  if (!command.trim()) return { kind: "refuse", reason: "The command is empty." };
  if (command.length > MAX_COMMAND_LENGTH) return { kind: "refuse", reason: `The command is longer than ${MAX_COMMAND_LENGTH} characters.` };
  if (command.includes("\0")) return { kind: "refuse", reason: "The command contains a NUL character." };
  if (policy === "none") return { kind: "refuse", reason: "Agent access is off for this server. The user can turn it on in VM Manager." };

  const block = checkBlocklist(command);
  if (block?.kind === "hard") {
    return { kind: "refuse", reason: `Blocked: \`${block.rule}\` is on the hard blocklist. VM Manager never runs it, even with approval.` };
  }

  const classification = classify(command);
  if (tool === "read") {
    if (!classification.readOnly) {
      return { kind: "refuse", reason: `Not a read-only command: ${classification.reason}. Use vm_change for this command.` };
    }
    return { kind: "run", readOnly: true, reason: "read-only" };
  }

  // A read-only command can't run SQL, so a match like `grep TRUNCATE dump.sql` is not destructive.
  if (classification.readOnly) return { kind: "run", readOnly: true, reason: "read-only" };
  if (block?.kind === "destructive") {
    if (!confirmDestructive) {
      return {
        kind: "refuse",
        reason: `\`${block.rule}\` destroys data. Call again with confirm_destructive: true if the user asked for it; the user then still has to approve it.`,
      };
    }
    return { kind: "approve", reason: `${block.rule} always needs approval` };
  }
  if (policy === "free") return { kind: "run", readOnly: false, reason: "this server lets agents run changes" };
  return { kind: "approve", reason: "changes on this server need approval" };
}
