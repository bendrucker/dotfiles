// EC2 tags are the source of truth for what exists and when it expires. The
// files under ~/.ssh/vm/ record what this machine wired up and which kind each
// VM launched as, so destroy can clean up after a VM its account already took.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { aws, EXPIRES_TAG, type Instance, instances, InstanceInformation, KIND_TAG, Launched, NAME_TAG, runCommand, toInstance } from "./aws.ts";
import { formatMinutes, isoSeconds, parseDuration } from "./duration.ts";
import { guestTools, miseRelease, toolLines, TOOLS_LOG, TOOLS_STATUS } from "./guest.ts";
import { HERDR, herdrRelease, knownMachines, type Machine, registerHerdr, unregisterHerdr } from "./herdr.ts";
import { accounts, kind as kindNamed, type Kind, type Kinds, loadKinds, localKindsPath, SHIPPED_KINDS_PATH } from "./kinds.ts";
import { errorMessage, log, until, UsageError } from "./process.ts";
import { installLines, type Release } from "./release.ts";
import { checkInclude, hostAlias, localFiles, localNames, publicKeys, readRecord, sshDir, sshEntry, type Tools, tools } from "./ssh.ts";
import { rejoinTailnet, tailnetAddress, tailnetKey, upCommand } from "./tailscale.ts";

function usage(): string {
  return `Usage: vm <command> [options]

  launch [--kind KIND] [--name NAME] [--type TYPE] [--ttl DURATION]
      Start a VM and wait until it is reachable. KIND picks the account and
      launch template. TYPE defaults to the template's, and DURATION to the
      kind's default time limit.
  connect NAME [COMMAND...]
      Open a shell on the VM, or run COMMAND there.
  copy NAME SRC [DEST]
      Copy SRC into DEST on the VM with rsync, leaving out node_modules. DEST
      defaults to the home directory, and a trailing slash on SRC copies its
      contents rather than the directory itself.
  extend NAME DURATION
      Push the time limit out by DURATION, never past the kind's maximum after
      the last start.
  pause NAME
      Stop the VM, keeping its disk, SSH entry, and herdr machine.
  resume NAME [--ttl DURATION]
      Start a paused VM with a fresh time limit.
  list [--json]
      Show each VM with its kind, type, and remaining time.
  destroy NAME
      Terminate the VM and remove its SSH entry and herdr machine.

DURATION is minutes and hours: 30m, 2h, 1h30m. The time limit stops the VM,
which resume can start again. Kinds come from ${SHIPPED_KINDS_PATH}
and ${localKindsPath()}. Each VM answers to ssh vm-NAME, over the tailnet
when it joined one, and to vm-NAME-ssm through Session Manager. vm-NAME is also
its herdr machine label: herdr --machine vm-NAME ...`;
}

export function validateName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    throw new UsageError(`name must be lowercase letters, digits, and dashes: ${name}`);
  }
  return name;
}

function randomName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => (byte % 36).toString(36)).join("");
}

// Minutes are computed on the instance, so the shutdown lands on the tagged
// time however long boot took. A new schedule replaces the pending one.
export function shutdownCommand(expiresAt: Date): string {
  const epoch = Math.floor(expiresAt.getTime() / 1000);
  return `shutdown -h +$(( (${epoch} - $(date +%s) + 59) / 60 ))`;
}

// Passing user data replaces the template's own shutdown, so this script
// schedules one first, before anything that could fail.
export interface Extras {
  herdr?: Release;
  tailnet?: { authKey: string; hostname: string; tag: string };
  guest?: { mise: Release; tools: Record<string, string> };
}

export function userData(expiresAt: Date, keys: string, { herdr, tailnet, guest }: Extras = {}): string {
  const lines = [
    "#!/bin/sh",
    shutdownCommand(expiresAt),
    "install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh",
    "cat >> /home/ec2-user/.ssh/authorized_keys <<'KEYS'",
    keys.trim(),
    "KEYS",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys",
    "chmod 600 /home/ec2-user/.ssh/authorized_keys",
    // vm copy runs rsync at both ends.
    "command -v rsync >/dev/null || dnf install -y -q rsync",
    ...(herdr ? installLines(HERDR, herdr) : []),
  ];
  // The key is single use and expires within the hour.
  if (tailnet) {
    lines.push("curl -fsSL https://tailscale.com/install.sh | sh", upCommand(tailnet.authKey, tailnet.hostname, tailnet.tag));
  }
  // Last, since it takes longest and the VM is usable without it.
  if (guest) lines.push(...toolLines(guest.mise, guest.tools));
  return [...lines, ""].join("\n");
}

interface Located {
  kind: Kind;
  vm?: Instance;
}

// The local record names the kind. A VM launched elsewhere is found by
// searching every account for its name tag.
function locate(name: string, kinds: Kinds): Located | undefined {
  validateName(name);
  const record = readRecord(name);
  if (record) {
    const recorded = kindNamed(kinds, record.kind);
    return { kind: recorded, vm: instances(recorded, name)[0] };
  }
  for (const account of accounts(kinds)) {
    const [vm] = reachable(account, (target) => instances(target, name)) ?? [];
    if (vm) return { kind: kinds.byName.get(vm.kind) ?? account, vm: { ...vm, kind: vm.kind || account.name } };
  }
  return undefined;
}

// One account failing, say a lapsed SSO session, leaves the others usable.
function reachable(account: Kind, query: (account: Kind) => Instance[]): Instance[] | undefined {
  try {
    return query(account);
  } catch (error) {
    log(`skipping ${account.profile} in ${account.region}: ${errorMessage(error)}`);
    return undefined;
  }
}

function instance(name: string, states: string[]): { kind: Kind; vm: Instance } {
  const found = locate(name, loadKinds());
  if (!found?.vm) throw new Error(`no VM named ${name}`);
  const { kind, vm } = found;
  if (!states.includes(vm.state)) throw new UsageError(`${name} is ${displayState(vm.state)}, not ${states.map(displayState).join(" or ")}`);
  return { kind, vm };
}

function displayState(state: string): string {
  return state === "stopped" ? "paused" : state;
}

interface LaunchOptions {
  name: string;
  kind: Kind;
  type?: string;
  ttlMinutes: number;
}

function parseFlags(command: string, args: string[], flags: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s, 2);
    if (!flags.includes(flag)) throw new UsageError(`unknown ${command} option: ${args[index]}`);
    values.set(flag, inline ?? args[++index] ?? "");
  }
  return values;
}

function parseTtl(text: string | undefined, kind: Kind): number {
  const minutes = text === undefined ? kind.defaultTtl : parseDuration(text);
  if (minutes > kind.maxTtl) {
    throw new UsageError(`time limit ${formatMinutes(minutes)} exceeds the ${formatMinutes(kind.maxTtl)} maximum for ${kind.name}`);
  }
  return minutes;
}

// The account's own policy decides which instance types it allows.
export function parseLaunch(args: string[], kinds: Kinds): LaunchOptions {
  const flags = parseFlags("launch", args, ["--kind", "--name", "--type", "--ttl"]);
  const kind = kindNamed(kinds, flags.get("--kind") ?? kinds.default);
  const name = flags.has("--name") ? validateName(flags.get("--name") ?? "") : randomName();
  return { name, kind, type: flags.get("--type"), ttlMinutes: parseTtl(flags.get("--ttl"), kind) };
}

function startInstance(options: LaunchOptions, expiresAt: Date, extras: Extras): Instance {
  const { kind, name } = options;
  const tags = [
    { Key: "Name", Value: hostAlias(name) },
    { Key: NAME_TAG, Value: name },
    { Key: KIND_TAG, Value: kind.name },
    { Key: EXPIRES_TAG, Value: isoSeconds(expiresAt) },
  ];
  const run = aws(kind, [
    "ec2",
    "run-instances",
    "--launch-template",
    `LaunchTemplateName=${kind.template}`,
    ...(options.type ? ["--instance-type", options.type] : []),
    "--user-data",
    userData(expiresAt, publicKeys(), extras),
    "--tag-specifications",
    JSON.stringify([{ ResourceType: "instance", Tags: tags }]),
  ], Launched);
  return toInstance(run.Instances[0]);
}

function waitOnline(kind: Kind, instanceId: string): void {
  log("waiting for Session Manager");
  until("Session Manager registration", () => {
    const info = aws(kind, ["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`], InstanceInformation);
    return info.InstanceInformationList[0]?.PingStatus === "Online" ? true : undefined;
  });
}

// cloud-init exits nonzero on harmless warnings, so the files are checked.
function waitReady(kind: Kind, instanceId: string, { herdr, guest }: Extras): void {
  waitOnline(kind, instanceId);
  log("waiting for user data to finish");
  const installed = [
    "test -s /home/ec2-user/.ssh/authorized_keys",
    ...(herdr ? [`test -x ${HERDR.target}`] : []),
    ...(guest ? [`cat ${TOOLS_STATUS}`] : []),
  ];
  const status = runCommand(kind, instanceId, `cloud-init status --wait >/dev/null; ${installed.join(" && ")}`).trim();
  if (guest && status !== "0") log(`mise could not install every tool (exit ${status}); see ${TOOLS_LOG} on the VM`);
}

async function launch(args: string[]): Promise<number> {
  const kinds = loadKinds();
  const options = parseLaunch(args, kinds);
  const { kind, name } = options;
  const resolved = tools(kind);
  // Names are unique across kinds, since the SSH alias and herdr label are.
  if (existsSync(localFiles(name).config) || locate(name, kinds)) throw new UsageError(`a VM named ${name} already exists`);

  const expiresAt = new Date(Date.now() + options.ttlMinutes * 60 * 1000);
  const [authKey, herdr, mise] = await Promise.all([tailnetKey(kind, name), herdrRelease(), miseRelease()]);
  const extras: Extras = {
    herdr,
    tailnet: authKey && kind.tailnet ? { authKey, hostname: hostAlias(name), tag: kind.tailnet.tag } : undefined,
    guest: mise ? { mise, tools: guestTools(kind) } : undefined,
  };
  const launched = startInstance(options, expiresAt, extras);
  log(`launched ${launched.id} (${kind.name}, ${launched.type}), expires ${isoSeconds(expiresAt)}`);

  let address: string | undefined;
  // The time limit would only stop an unreachable VM, leaving it for the
  // account to clean up.
  try {
    writeEntry(name, kind, launched.id, address, resolved);
    waitReady(kind, launched.id, extras);
    address = authKey ? tailnetAddress(kind, launched.id) : undefined;
    if (address) writeEntry(name, kind, launched.id, address, resolved);
  } catch (error) {
    log(`launch failed, so destroying ${name}`);
    try {
      destroy([name]);
    } catch (cleanup) {
      log(`destroy failed too, so ${launched.id} is still running: ${errorMessage(cleanup)}`);
    }
    throw error;
  }

  log("registering with herdr");
  const machine = registerHerdr(name);
  return report({ ...launched, name, kind: kind.name }, expiresAt, address, machine);
}

function writeEntry(name: string, kind: Kind, instanceId: string, address: string | undefined, resolved: Tools): void {
  const files = localFiles(name);
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  writeFileSync(files.record, `${JSON.stringify({ kind: kind.name })}\n`);
  writeFileSync(files.config, sshEntry(hostAlias(name), instanceId, address, files.knownHosts, resolved));
  checkInclude(name, instanceId);
}

function tagExpiry(kind: Kind, instanceId: string, expiresAt: Date): void {
  aws(kind, ["ec2", "create-tags", "--resources", instanceId, "--tags", `Key=${EXPIRES_TAG},Value=${isoSeconds(expiresAt)}`], z.unknown());
}

// Callers read herdr-machine to drive the VM, so a VM herdr cannot reach exits
// nonzero.
function report(vm: Pick<Instance, "id" | "name" | "kind" | "type">, expiresAt: Date, address: string | undefined, machine: string | undefined): number {
  console.log(`name: ${vm.name}`);
  console.log(`kind: ${vm.kind}`);
  console.log(`instance: ${vm.id}`);
  console.log(`type: ${vm.type}`);
  console.log(`expires-at: ${isoSeconds(expiresAt)}`);
  console.log(`tailnet: ${address ?? "none, reached through Session Manager"}`);
  console.log(`ssh: ssh ${hostAlias(vm.name)}`);
  console.log(`herdr-machine: ${machine ?? "not registered"}`);
  return machine ? 0 : 1;
}

function requireEntry(name: string): void {
  validateName(name);
  if (!existsSync(localFiles(name).config)) throw new Error(`no SSH entry for ${name}; was it launched from this machine?`);
}

function interactive(cmd: string[]): number {
  return Bun.spawnSync({ cmd, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 128;
}

function connect(args: string[]): number {
  const [name, ...command] = args;
  if (!name) throw new UsageError("connect needs a VM name");
  requireEntry(name);
  return interactive(["ssh", hostAlias(name), ...command]);
}

function copy(args: string[]): number {
  const [name, source, destination = "", ...rest] = args;
  if (!name || !source || rest.length > 0) throw new UsageError("copy needs a VM name, a source, and at most one destination");
  requireEntry(name);
  return interactive(["rsync", "-az", "--exclude", "node_modules", source, `${hostAlias(name)}:${destination}`]);
}

// EC2 resets LaunchTime on every start, the clock the reaper stops a VM by.
export function extendedExpiry(vm: { launchedAt: Date; expiresAt?: Date }, minutes: number, maxTtl: number, now: Date): Date {
  const from = Math.max(vm.expiresAt?.getTime() ?? now.getTime(), now.getTime());
  const next = new Date(from + minutes * 60 * 1000);
  const limit = new Date(vm.launchedAt.getTime() + maxTtl * 60 * 1000);
  if (next > limit) {
    const room = (limit.getTime() - from) / 60000;
    throw new UsageError(
      `extending by ${formatMinutes(minutes)} passes the ${formatMinutes(maxTtl)} limit at ${isoSeconds(limit)}; at most ${formatMinutes(room)} remains`,
    );
  }
  return next;
}

function extend(args: string[]): number {
  const [name, duration] = args;
  if (!name || !duration) throw new UsageError("extend needs a VM name and a duration");
  const minutes = parseDuration(duration);
  const { kind, vm } = instance(name, ["pending", "running"]);
  const expiresAt = extendedExpiry(vm, minutes, kind.maxTtl, new Date());
  // Reschedule before retagging, so a failure leaves the tag no later than the
  // shutdown it describes.
  runCommand(kind, vm.id, shutdownCommand(expiresAt));
  tagExpiry(kind, vm.id, expiresAt);
  console.log(`${name} now expires at ${isoSeconds(expiresAt)}`);
  return 0;
}

function pause(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || rest.length > 0) throw new UsageError("pause needs a VM name");
  const { kind, vm } = instance(name, ["pending", "running"]);
  aws(kind, ["ec2", "stop-instances", "--instance-ids", vm.id], z.unknown());
  console.log(`${name} paused; resume ${name} starts it again`);
  return 0;
}

// The tag goes first, so the reaper never sees a started VM carrying the
// expiry that stopped it. User data ran on first boot only.
async function resume(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name) throw new UsageError("resume needs a VM name");
  const ttl = parseFlags("resume", rest, ["--ttl"]).get("--ttl");
  const { kind, vm } = instance(name, ["stopping", "stopped"]);
  const ttlMinutes = parseTtl(ttl, kind);
  if (vm.state === "stopping") {
    log(`waiting for ${vm.id} to finish stopping`);
    until("the VM to stop", () => (instances(kind, name)[0]?.state === "stopped" ? true : undefined));
  }
  const resolved = tools(kind);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  tagExpiry(kind, vm.id, expiresAt);
  aws(kind, ["ec2", "start-instances", "--instance-ids", vm.id], z.unknown());
  log(`starting ${vm.id}, expires ${isoSeconds(expiresAt)}`);

  waitOnline(kind, vm.id);
  runCommand(kind, vm.id, shutdownCommand(expiresAt));
  const address = await rejoinTailnet(kind, vm.id, name);
  writeEntry(name, kind, vm.id, address, resolved);

  log("registering with herdr");
  const machine = registerHerdr(name);
  return report(vm, expiresAt, address, machine);
}

interface Row {
  name: string;
  kind: string;
  herdr: string;
  instance: string;
  type: string;
  state: string;
  expiresAt: string;
  remaining: string;
}

// A paused VM's expiry already passed. A local name with no instance stays
// listed as gone until destroy clears it.
export function rows(vms: Instance[], local: { name: string; kind: string }[], machines: Machine[], now: Date): Row[] {
  const label = (name: string) => machines.find((machine) => machine.target === hostAlias(name))?.label ?? "";
  const live = vms.map((vm) => ({
    name: vm.name,
    kind: vm.kind,
    herdr: label(vm.name),
    instance: vm.id,
    type: vm.type,
    state: displayState(vm.state),
    expiresAt: vm.expiresAt && vm.state !== "stopped" ? isoSeconds(vm.expiresAt) : "",
    remaining: vm.expiresAt && vm.state !== "stopped" ? formatMinutes((vm.expiresAt.getTime() - now.getTime()) / 60000) : "",
  }));
  const gone = local
    .filter(({ name }) => !vms.some((vm) => vm.name === name))
    .map(({ name, kind }) => ({ name, kind, herdr: label(name), instance: "", type: "", state: "gone", expiresAt: "", remaining: "" }));
  return [...live, ...gone].sort((a, b) => a.name.localeCompare(b.name));
}

function liveInstances(kinds: Kinds): { vms: Instance[]; complete: boolean } {
  const found = accounts(kinds).map((account) => reachable(account, instances)?.map((vm) => ({ ...vm, kind: vm.kind || account.name })));
  return { vms: found.flatMap((vms) => vms ?? []), complete: found.every(Boolean) };
}

function list(args: string[]): number {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown) throw new UsageError(`unknown list option: ${unknown}`);
  const local = localNames().map((name) => ({ name, kind: readRecord(name)?.kind ?? "" }));
  const { vms, complete } = liveInstances(loadKinds());
  const table = rows(vms, local, knownMachines(), new Date());
  // A skipped account leaves the listing short, which a caller has to know.
  const status = complete ? 0 : 1;
  if (args.includes("--json")) {
    console.log(JSON.stringify(table, null, 2));
    return status;
  }
  if (table.length === 0) return status;
  const header: Row = { name: "NAME", kind: "KIND", herdr: "HERDR", instance: "INSTANCE", type: "TYPE", state: "STATE", expiresAt: "EXPIRES", remaining: "REMAINING" };
  const columns = Object.keys(header) as (keyof Row)[];
  const widths = columns.map((column) => Math.max(...[header, ...table].map((row) => row[column].length)));
  for (const row of [header, ...table]) {
    console.log(columns.map((column, index) => row[column].padEnd(widths[index])).join("  ").trimEnd());
  }
  return status;
}

function destroy(args: string[]): number {
  const [name] = args;
  if (!name) throw new UsageError("destroy needs a VM name");
  const found = locate(name, loadKinds());
  const files = localFiles(name);
  if (!found?.vm && !existsSync(files.config)) throw new Error(`no VM named ${name}`);
  const vm = found?.vm;
  if (found && vm) {
    aws(found.kind, ["ec2", "terminate-instances", "--instance-ids", vm.id], z.unknown());
    log(`terminating ${vm.id}`);
  }
  rmSync(files.config, { force: true });
  rmSync(files.knownHosts, { force: true });
  rmSync(files.record, { force: true });
  unregisterHerdr(name);
  console.log(`${name} destroyed`);
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { launch, connect, copy, extend, pause, resume, list, destroy };

const isHelp = (arg: string | undefined) => arg === "-h" || arg === "--help";

// Everything after connect's name belongs to the remote command, so only a
// flag in its place asks for help.
function wantsHelp(command: string, args: string[]): boolean {
  return command === "connect" ? isHelp(args[0]) : args.some(isHelp);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || isHelp(command) || command === "help" || (command in COMMANDS && wantsHelp(command, args))) {
    console.log(usage());
    return command ? 0 : 2;
  }
  const handler = COMMANDS[command];
  try {
    if (!handler) throw new UsageError(`unknown command: ${command}`);
    return await handler(args);
  } catch (error) {
    log(errorMessage(error));
    if (error instanceof UsageError) process.stderr.write(`\n${usage()}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
