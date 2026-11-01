import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  stateDir: string;
  vmsFile: string;
  approvalsDir: string;
  auditFile: string;
  statusFile: string;
  askpassDir: string;
  lockDir: string;
  logFile: string;
  sshDir: string;
  sshConfig: string;
  sshManagedConfig: string;
  keychainService: string;
}

/** Every path VM Manager touches. VM_MANAGER_HOME moves its own state; HOME moves ~/.ssh (tests and dry runs use a temp HOME). */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir();
  const stateDir = env.VM_MANAGER_HOME ?? join(home, ".config", "vm-manager");
  const sshDir = join(home, ".ssh");
  return {
    home,
    stateDir,
    vmsFile: join(stateDir, "vms.json"),
    approvalsDir: join(stateDir, "approvals"),
    auditFile: join(stateDir, "audit.jsonl"),
    statusFile: join(stateDir, "status.json"),
    askpassDir: join(stateDir, "askpass"),
    lockDir: join(stateDir, "lock"),
    logFile: join(stateDir, "vm-manager.log"),
    sshDir,
    sshConfig: join(sshDir, "config"),
    sshManagedConfig: join(sshDir, "config.d", "vm-manager.conf"),
    keychainService: env.VM_MANAGER_KEYCHAIN_SERVICE ?? "vm-manager",
  };
}

/** Expands a leading ~ the way ssh does. */
export function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function tildify(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
