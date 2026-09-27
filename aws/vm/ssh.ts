
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Account } from "./kinds.ts";
import { log, spawn, which } from "./process.ts";

export const PREFIX = "vm";

export function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface Tools {
  aws: string;
  plugin: string;
  profile: string;
  region: string;
  configFile?: string;
}

// herdr's server runs under launchd, whose PATH holds neither aws nor the
// Session Manager plugin, so both go in by absolute path.
export function proxyCommand(tools: Tools): string {
  const env = [`PATH=${dirname(tools.plugin)}:/usr/bin:/bin`];
  if (tools.configFile) env.push(`AWS_CONFIG_FILE=${tools.configFile}`);
  const proxy = [
    "/usr/bin/env",
    ...env,
    tools.aws,
    "ssm",
    "start-session",
    "--profile",
    tools.profile,
    "--region",
    tools.region,
    "--target",
    "%h",
    "--document-name",
    "AWS-StartSSHSession",
    "--parameters",
    "portNumber=%p",
  ];
  return proxy.map(quote).join(" ");
}

// The -ssm alias always goes through Session Manager, which needs no secret
// and survives a VM whose tailscale up failed.
export function sshEntry(host: string, instanceId: string, tailnetIp: string | undefined, knownHosts: string, tools: Tools): string {
  const common = [
    "  User ec2-user",
    `  HostKeyAlias ${host}`,
    "  StrictHostKeyChecking accept-new",
    `  UserKnownHostsFile ${quote(knownHosts)}`,
    // Session Manager drops a session idle for 20 minutes.
    "  ServerAliveInterval 30",
    // herdr connects per forwarded command, and Secretive fails the odd
    // signature. A shared connection signs once.
    "  ControlMaster auto",
    `  ControlPath ${quote(`${sshDir()}/%C`)}`,
    "  ControlPersist 10m",
  ];
  const viaSsm = [`  HostName ${instanceId}`, `  ProxyCommand ${proxyCommand(tools)}`];
  return [
    `Host ${host}`,
    ...(tailnetIp ? [`  HostName ${tailnetIp}`] : viaSsm),
    ...common,
    "",
    `Host ${host}-ssm`,
    ...viaSsm,
    ...common,
    "",
  ].join("\n");
}

export function sshDir(): string {
  return join(process.env.HOME || homedir(), ".ssh", PREFIX);
}

export function hostAlias(name: string): string {
  return `${PREFIX}-${name}`;
}

export function localFiles(name: string): { config: string; knownHosts: string; record: string } {
  return {
    config: join(sshDir(), `${name}.conf`),
    knownHosts: join(sshDir(), `${name}.known_hosts`),
    record: join(sshDir(), `${name}.json`),
  };
}

const Record = z.object({ kind: z.string() });

// Which kind a VM launched as, so later commands reach the right account.
export function readRecord(name: string): z.infer<typeof Record> | undefined {
  const path = localFiles(name).record;
  if (!existsSync(path)) return undefined;
  return Record.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function localNames(): string[] {
  if (!existsSync(sshDir())) return [];
  return readdirSync(sshDir())
    .filter((file) => file.endsWith(".conf"))
    .map((file) => file.slice(0, -".conf".length))
    .sort();
}

export function publicKeys(): string {
  const agent = /^identityagent (.+)$/m.exec(spawn(["ssh", "-G", "localhost"]).stdout)?.[1];
  const env = agent && agent !== "none" && agent !== "SSH_AUTH_SOCK" ? { SSH_AUTH_SOCK: agent.replace(/^~/, homedir()) } : undefined;
  const result = spawn(["ssh-add", "-L"], env);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("the SSH agent offered no public keys (ssh-add -L)");
  return result.stdout;
}

// A machine whose ssh/config predates the Include resolves the alias to itself.
export function checkInclude(name: string, instanceId: string): void {
  const resolved = /^hostname (.+)$/m.exec(spawn(["ssh", "-G", `${hostAlias(name)}-ssm`]).stdout)?.[1];
  if (resolved !== instanceId) {
    log(`~/.ssh/config does not include ${sshDir()}/*.conf yet, so ${hostAlias(name)} will not resolve`);
  }
}

// A mise shim picks its version from the directory it runs in, which a
// ProxyCommand does not control, so the entry names the binary aws/mise.toml
// pins.
function sessionManagerPlugin(): string {
  const found = which("session-manager-plugin", "Install it with: mise install");
  if (!found.includes("/mise/shims/")) return found;
  const resolved = spawn(["mise", "-C", join(import.meta.dir, ".."), "which", "session-manager-plugin"]);
  if (resolved.status !== 0) throw new Error(`mise cannot resolve session-manager-plugin: ${resolved.stderr.trim()}\nInstall it with: mise install`);
  return resolved.stdout.trim();
}

export function tools(account: Account): Tools {
  return {
    aws: which("aws", "Install it with: brew install awscli"),
    plugin: sessionManagerPlugin(),
    profile: account.profile,
    region: account.region,
    configFile: process.env.AWS_CONFIG_FILE,
  };
}
