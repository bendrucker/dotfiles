// The herdr release a VM needs so `herdr machine add` can save it unattended.
// herdr refuses a remote whose version differs from the local one, and installs
// one itself only after an interactive approval.

import { z } from "zod";
import { localRelease, type Release, type Source } from "./release.ts";
import { hostAlias } from "./ssh.ts";
import { errorMessage, log, POLL_MS, READY_TIMEOUT_MS, sleep, spawn } from "./process.ts";

const ADD_ATTEMPTS = 3;

export const HERDR: Source = {
  tool: "herdr",
  repo: "herdrdev/herdr",
  target: "/home/ec2-user/.local/bin/herdr",
  tag: (version) => `v${version}`,
  asset: (_version, arch) => `herdr-linux-${arch}`,
};

export const Machines = z.array(z.object({ id: z.string(), label: z.string(), target: z.string() }));
export type Machine = z.infer<typeof Machines>[number];

export function herdrMachines(): Machine[] {
  const result = spawn(["herdr", "machine", "list", "--json"]);
  if (result.status !== 0) throw new Error(`herdr machine list failed: ${result.stderr.trim()}`);
  return Machines.parse(JSON.parse(result.stdout));
}

export function knownMachines(): Machine[] {
  if (!Bun.which("herdr")) return [];
  try {
    return herdrMachines();
  } catch (error) {
    log(errorMessage(error));
    return [];
  }
}

export function herdrRelease(): Promise<Release | undefined> {
  return localRelease(HERDR);
}

// The label is the SSH alias: one shell word, since callers drive the VM with
// `herdr --machine <label> ...`, and unique, since the name is. Adding is also
// what starts the remote server, which a stopped VM loses, so resume replaces
// the profile rather than reusing it.
export function registerHerdr(name: string): string | undefined {
  if (!Bun.which("herdr")) {
    log("herdr is not on PATH, so the VM is not registered as a herdr machine");
    return undefined;
  }
  unregisterHerdr(name);
  const label = hostAlias(name);
  // A hardware-backed agent like Secretive fails the odd signature outright,
  // and one failed SSH connection fails the add.
  for (let attempt = 1; ; attempt++) {
    const added = spawn(["herdr", "machine", "add", "--label", label, label]);
    if (added.status === 0) break;
    if (attempt === ADD_ATTEMPTS) {
      log(`herdr machine add failed: ${(added.stderr || added.stdout).trim()}`);
      return undefined;
    }
  }
  return awaitHerdr(label);
}

// A forwarded command that answers is the readiness launch and resume promise,
// rather than a saved profile whose server may still be starting.
function awaitHerdr(label: string): string | undefined {
  let last = "";
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = spawn(["herdr", "--machine", label, "workspace", "list"]);
    if (probe.status === 0) return label;
    last = (probe.stderr || probe.stdout).trim();
    sleep(POLL_MS);
  }
  log(`herdr machine ${label} never answered a forwarded command: ${last}`);
  return undefined;
}

// A failure here leaves a stale profile to remove by hand, which beats failing
// a launch or destroy whose real work already succeeded.
export function unregisterHerdr(name: string): void {
  if (!Bun.which("herdr")) return;
  let machines: Machine[];
  try {
    machines = herdrMachines();
  } catch (error) {
    log(errorMessage(error));
    return;
  }
  for (const machine of machines.filter((entry) => entry.target === hostAlias(name))) {
    const result = spawn(["herdr", "machine", "remove", machine.id]);
    if (result.status !== 0) log(`herdr machine remove ${machine.id} failed: ${result.stderr.trim()}`);
  }
}
