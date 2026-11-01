import { MacKeychain, type SecretStore } from "../infra/keychain.ts";
import { fileLogger, type Logger } from "../infra/log.ts";
import { type Paths, resolvePaths } from "../infra/paths.ts";
import { ApprovalStore } from "./approvals.ts";
import { AskpassSessions, selfCommand } from "./askpass.ts";
import { AuditLog } from "./audit.ts";
import { InventoryStore } from "./inventory.ts";
import { type Runner, SshRunner } from "./ssh.ts";
import { Supervisor } from "./supervisor.ts";

export interface Context {
  paths: Paths;
  inventory: InventoryStore;
  approvals: ApprovalStore;
  audit: AuditLog;
  secrets: SecretStore;
  sessions: AskpassSessions;
  runner: Runner;
  supervisor: Supervisor;
  log: Logger;
}

export function createContext(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<Context, "secrets" | "runner" | "log">> & { approvalTimeoutMs?: number; pollMs?: number } = {},
): Context {
  const paths = resolvePaths(env);
  const approvals = new ApprovalStore(paths.approvalsDir);
  const audit = new AuditLog(paths.auditFile);
  const sessions = new AskpassSessions(paths.askpassDir, selfCommand());
  const runner = overrides.runner ?? new SshRunner({ home: paths.home, sessions });
  return {
    paths,
    inventory: new InventoryStore(paths),
    approvals,
    audit,
    secrets: overrides.secrets ?? new MacKeychain(),
    sessions,
    runner,
    supervisor: new Supervisor({ approvals, audit, runner, approvalTimeoutMs: overrides.approvalTimeoutMs, pollMs: overrides.pollMs }),
    log: overrides.log ?? fileLogger(paths.logFile),
  };
}
