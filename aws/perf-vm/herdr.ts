// The herdr release a VM needs so `herdr machine add` can save it unattended.
// herdr refuses a remote whose version differs from the local one, and installs
// one itself only after an interactive approval.

import { z } from "zod";
import { hostAlias } from "./ssh.ts";
import { log, POLL_MS, READY_TIMEOUT_MS, sleep, spawn } from "./process.ts";

// Every instance type the account allows is Graviton.
const ASSET = "herdr-linux-aarch64";
const ADD_ATTEMPTS = 3;

export interface Release {
  url: string;
  sha256: string;
}

const GitHubRelease = z.object({
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullable() })),
});

export async function release(version: string, api = "https://api.github.com"): Promise<Release> {
  const response = await fetch(`${api}/repos/herdrdev/herdr/releases/tags/v${version}`);
  if (!response.ok) throw new Error(`herdr release v${version} lookup failed: ${response.status}`);
  const asset = GitHubRelease.parse(await response.json()).assets.find((candidate) => candidate.name === ASSET);
  const sha256 = asset?.digest?.replace(/^sha256:/, "");
  if (!asset || !sha256) throw new Error(`herdr release v${version} has no ${ASSET} with a digest`);
  return { url: asset.browser_download_url, sha256 };
}

export const BINARY = "/home/ec2-user/.local/bin/herdr";

export function installLines(herdr: Release): string[] {
  return [
    "install -d -o ec2-user -g ec2-user /home/ec2-user/.local /home/ec2-user/.local/bin",
    `curl -fsSL --retry 3 -o /tmp/herdr ${herdr.url}`,
    `echo '${herdr.sha256}  /tmp/herdr' | sha256sum -c -`,
    `install -m 755 -o ec2-user -g ec2-user /tmp/herdr ${BINARY}`,
  ];
}

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
    log((error as Error).message);
    return [];
  }
}

// The release matching the local herdr, for user data to install. Without one,
// launch still starts a VM that SSH reaches.
export async function herdrRelease(): Promise<Release | undefined> {
  if (!Bun.which("herdr")) return undefined;
  const version = /(\d+\.\d+\.\d+\S*)/.exec(spawn(["herdr", "--version"]).stdout)?.[1];
  if (!version) {
    log("could not read the local herdr version, so the VM gets no herdr");
    return undefined;
  }
  try {
    return await release(version, process.env.PERF_VM_GITHUB_API);
  } catch (error) {
    log(`${(error as Error).message}; the VM gets no herdr`);
    return undefined;
  }
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

export function unregisterHerdr(name: string): void {
  if (!Bun.which("herdr")) return;
  for (const machine of herdrMachines().filter((entry) => entry.target === hostAlias(name))) {
    const result = spawn(["herdr", "machine", "remove", machine.id]);
    if (result.status !== 0) log(`herdr machine remove ${machine.id} failed: ${result.stderr.trim()}`);
  }
}
