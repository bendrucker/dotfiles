//
// Launch, reach, and tear down short-lived Linux VMs in the performance AWS
// account, each registered as a herdr remote machine.
//
// The account opens no inbound ports. A VM joins the tailnet when the account
// holds a Tailscale OAuth client, and SSH always also rides a Session Manager
// session. Both are set up by one generated file per VM in ~/.ssh/perf-vm/,
// which ssh/config includes. EC2 tags are the source of truth for what exists and when it
// expires. The files under ~/.ssh/perf-vm/ only record what this machine has
// wired up, so destroy can clean up after a VM its time limit already took.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { aws, EXPIRES_TAG, type Instance, instances, Launched, NAME_TAG, runCommand, toInstance, InstanceInformation } from "./aws.ts";
import {
  BINARY as HERDR_BINARY,
  herdrRelease,
  installLines,
  knownMachines,
  type Machine,
  registerHerdr,
  type Release,
  unregisterHerdr,
} from "./herdr.ts";
import { log, until, UsageError } from "./process.ts";
import { checkInclude, hostAlias, localFiles, localNames, publicKeys, sshDir, sshEntry, tools } from "./ssh.ts";
import { rejoinTailnet, tailnetAddress, tailnetKey, upCommand } from "./tailscale.ts";

const USAGE = `Usage: perf-vm <command> [options]

  launch [--name NAME] [--type TYPE] [--ttl DURATION]
      Start a VM and wait until it is reachable. TYPE defaults to the launch
      template's. DURATION defaults to 4h and may not exceed 12h.
  connect NAME [COMMAND...]
      Open a shell on the VM, or run COMMAND there.
  extend NAME DURATION
      Push the time limit out by DURATION, never past 12h after the last start.
  pause NAME
      Stop the VM, keeping its disk, SSH entry, and herdr machine.
  resume NAME [--ttl DURATION]
      Start a paused VM with a fresh time limit, 4h unless DURATION says.
  list [--json]
      Show each VM with its type and remaining time.
  destroy NAME
      Terminate the VM and remove its SSH entry and herdr machine.

DURATION is minutes and hours: 30m, 2h, 1h30m. The time limit stops the VM,
which resume can start again. The account terminates any VM 7 days after launch.
Each VM answers to ssh perf-vm-NAME, over the tailnet when it joined one, and
to perf-vm-NAME-ssm through Session Manager. perf-vm-NAME is also its herdr
machine label: herdr --machine perf-vm-NAME ...
PERF_VM_PROFILE names the AWS profile (default performance-admin).`;

const TEMPLATE = "performance";
const DEFAULT_TTL_MINUTES = 240;
const MAX_TTL_MINUTES = 12 * 60;

// The account's service control policy allows these and nothing else. Checking
// here turns an opaque UnauthorizedOperation into a message naming the choices.
const FAMILIES = ["c8g", "m8g", "r8g"];
const SIZES = ["medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "metal-24xl"];
export const INSTANCE_TYPES = FAMILIES.flatMap((family) => SIZES.map((size) => `${family}.${size}`));

export function parseDuration(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!text || !match) throw new UsageError(`not a duration: ${text} (use 30m, 2h, 1h30m)`);
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  if (minutes <= 0) throw new UsageError(`duration must be positive: ${text}`);
  return minutes;
}

export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
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

// ISO 8601 UTC to the second, the shape the expiry backstop parses.
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The instance computes its own minutes from the expiry, so the shutdown lands
// on the tagged time however long boot or an SSM round trip took. On systemd a
// new schedule replaces the pending one, which is what makes extend work.
export function shutdownCommand(expiresAt: Date): string {
  const epoch = Math.floor(expiresAt.getTime() / 1000);
  return `shutdown -h +$(( (${epoch} - $(date +%s) + 59) / 60 ))`;
}

// The launch template's user data carries its own four-hour shutdown. Passing
// user data replaces it, so this script has to carry the time limit itself,
// and does so first in case anything after it fails.
export interface Extras {
  herdr?: Release;
  tailnet?: { authKey: string; hostname: string };
}

export function userData(expiresAt: Date, keys: string, { herdr, tailnet }: Extras = {}): string {
  const lines = [
    "#!/bin/sh",
    shutdownCommand(expiresAt),
    "install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh",
    "cat >> /home/ec2-user/.ssh/authorized_keys <<'KEYS'",
    keys.trim(),
    "KEYS",
    "chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys",
    "chmod 600 /home/ec2-user/.ssh/authorized_keys",
    ...(herdr ? installLines(herdr) : []),
  ];
  // The key is single use and expires within the hour, which is what makes it
  // acceptable in user data any process on the VM can read back.
  if (tailnet) {
    lines.push("curl -fsSL https://tailscale.com/install.sh | sh", upCommand(tailnet.authKey, tailnet.hostname));
  }
  return [...lines, ""].join("\n");
}

function instance(name: string, states: string[]): Instance {
  const [found] = instances(validateName(name));
  if (!found) throw new Error(`no VM named ${name}`);
  if (!states.includes(found.state)) throw new UsageError(`${name} is ${displayState(found.state)}, not ${states.map(displayState).join(" or ")}`);
  return found;
}

// A stopped VM is one pause or its time limit stopped, and resume can start it.
function displayState(state: string): string {
  return state === "stopped" ? "paused" : state;
}

interface LaunchOptions {
  name: string;
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

function parseTtl(text: string | undefined): number {
  const minutes = text === undefined ? DEFAULT_TTL_MINUTES : parseDuration(text);
  if (minutes > MAX_TTL_MINUTES) throw new UsageError(`time limit ${formatMinutes(minutes)} exceeds the 12h maximum`);
  return minutes;
}

export function parseLaunch(args: string[]): LaunchOptions {
  const flags = parseFlags("launch", args, ["--name", "--type", "--ttl"]);
  const name = flags.has("--name") ? validateName(flags.get("--name") ?? "") : randomName();
  const type = flags.get("--type");
  if (type !== undefined && !INSTANCE_TYPES.includes(type)) {
    throw new UsageError(`instance type ${type} is not allowed in the performance account (c8g, m8g, r8g up to 16xlarge, or metal-24xl)`);
  }
  return { name, type, ttlMinutes: parseTtl(flags.get("--ttl")) };
}

function startInstance(options: LaunchOptions, expiresAt: Date, authKey: string | undefined, herdr: Release | undefined): Instance {
  const tags = [
    { Key: "Name", Value: hostAlias(options.name) },
    { Key: NAME_TAG, Value: options.name },
    { Key: EXPIRES_TAG, Value: isoSeconds(expiresAt) },
  ];
  const tailnet = authKey ? { authKey, hostname: hostAlias(options.name) } : undefined;
  const run = aws([
    "ec2",
    "run-instances",
    "--launch-template",
    `LaunchTemplateName=${TEMPLATE}`,
    ...(options.type ? ["--instance-type", options.type] : []),
    "--user-data",
    userData(expiresAt, publicKeys(), { herdr, tailnet }),
    "--tag-specifications",
    JSON.stringify([{ ResourceType: "instance", Tags: tags }]),
  ], Launched);
  return toInstance(run.Instances[0]);
}

// Session Manager first, since every later step runs through it.
function waitOnline(instanceId: string): void {
  log("waiting for Session Manager");
  until("Session Manager registration", () => {
    const info = aws(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`], InstanceInformation);
    return info.InstanceInformationList[0]?.PingStatus === "Online" ? true : undefined;
  });
}

// cloud-init exits nonzero for warnings that leave the keys in place, so the
// keys are what gets checked.
function waitReady(instanceId: string, herdr: boolean): void {
  waitOnline(instanceId);
  log("waiting for user data to finish");
  const installed = ["test -s /home/ec2-user/.ssh/authorized_keys", ...(herdr ? [`test -x ${HERDR_BINARY}`] : [])];
  runCommand(instanceId, `cloud-init status --wait >/dev/null; ${installed.join(" && ")}`);
}

async function launch(args: string[]): Promise<number> {
  const options = parseLaunch(args);
  const resolved = tools();
  if (instances(options.name).length > 0) throw new UsageError(`a VM named ${options.name} already exists`);

  const expiresAt = new Date(Date.now() + options.ttlMinutes * 60 * 1000);
  const authKey = await tailnetKey(options.name);
  const herdr = await herdrRelease();
  const launched = startInstance(options, expiresAt, authKey, herdr);
  log(`launched ${launched.id} (${launched.type}), expires ${isoSeconds(expiresAt)}`);

  const host = hostAlias(options.name);
  const files = localFiles(options.name);
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  writeFileSync(files.config, sshEntry(host, launched.id, undefined, files.knownHosts, resolved));
  checkInclude(options.name, launched.id);

  waitReady(launched.id, herdr !== undefined);
  const address = authKey ? tailnetAddress(launched.id) : undefined;
  if (address) writeFileSync(files.config, sshEntry(host, launched.id, address, files.knownHosts, resolved));

  log("registering with herdr");
  const machine = registerHerdr(options.name);
  return report({ ...launched, name: options.name }, expiresAt, address, machine);
}

// The summary launch and resume end on. Callers read herdr-machine to drive the
// VM, so a VM herdr cannot reach exits nonzero.
function report(vm: Pick<Instance, "id" | "name" | "type">, expiresAt: Date, address: string | undefined, machine: string | undefined): number {
  console.log(`name: ${vm.name}`);
  console.log(`instance: ${vm.id}`);
  console.log(`type: ${vm.type}`);
  console.log(`expires-at: ${isoSeconds(expiresAt)}`);
  console.log(`tailnet: ${address ?? "none, reached through Session Manager"}`);
  console.log(`ssh: ssh ${hostAlias(vm.name)}`);
  console.log(`herdr-machine: ${machine ?? "not registered"}`);
  return machine ? 0 : 1;
}

function connect(args: string[]): number {
  const [name, ...command] = args;
  if (!name) throw new UsageError("connect needs a VM name");
  validateName(name);
  if (!existsSync(localFiles(name).config)) throw new Error(`no SSH entry for ${name}; was it launched from this machine?`);
  const child = Bun.spawnSync({ cmd: ["ssh", hostAlias(name), ...command], stdio: ["inherit", "inherit", "inherit"] });
  return child.exitCode ?? 128;
}

// The new expiry, refusing one past 12 hours after the last start rather than
// quietly granting less than was asked. EC2 resets LaunchTime on every start,
// which is the same clock the account's reaper stops a VM by.
export function extendedExpiry(vm: { launchedAt: Date; expiresAt?: Date }, minutes: number, now: Date): Date {
  const from = Math.max(vm.expiresAt?.getTime() ?? now.getTime(), now.getTime());
  const next = new Date(from + minutes * 60 * 1000);
  const limit = new Date(vm.launchedAt.getTime() + MAX_TTL_MINUTES * 60 * 1000);
  if (next > limit) {
    const room = (limit.getTime() - from) / 60000;
    throw new UsageError(
      `extending by ${formatMinutes(minutes)} passes the 12h limit at ${isoSeconds(limit)}; at most ${formatMinutes(room)} remains`,
    );
  }
  return next;
}

function extend(args: string[]): number {
  const [name, duration] = args;
  if (!name || !duration) throw new UsageError("extend needs a VM name and a duration");
  const minutes = parseDuration(duration);
  const vm = instance(name, ["pending", "running"]);
  const expiresAt = extendedExpiry(vm, minutes, new Date());
  // Reschedule before retagging, so a failure leaves the tag no later than the
  // shutdown it describes.
  runCommand(vm.id, shutdownCommand(expiresAt));
  aws(["ec2", "create-tags", "--resources", vm.id, "--tags", `Key=${EXPIRES_TAG},Value=${isoSeconds(expiresAt)}`], z.unknown());
  console.log(`${name} now expires at ${isoSeconds(expiresAt)}`);
  return 0;
}

function pause(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || rest.length > 0) throw new UsageError("pause needs a VM name");
  const vm = instance(name, ["pending", "running"]);
  aws(["ec2", "stop-instances", "--instance-ids", vm.id], z.unknown());
  console.log(`${name} paused; resume ${name} starts it again`);
  return 0;
}

// Pause's stop can still be in progress, so resume waits it out. The tag goes
// first, so the reaper never sees a started VM still carrying the expiry that
// stopped it. User data ran on first boot only, so the shutdown is rescheduled
// here.
async function resume(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name) throw new UsageError("resume needs a VM name");
  const ttlMinutes = parseTtl(parseFlags("resume", rest, ["--ttl"]).get("--ttl"));
  const vm = instance(name, ["stopping", "stopped"]);
  if (vm.state === "stopping") {
    log(`waiting for ${vm.id} to finish stopping`);
    until("the VM to stop", () => (instances(name)[0]?.state === "stopped" ? true : undefined));
  }
  const resolved = tools();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  aws(["ec2", "create-tags", "--resources", vm.id, "--tags", `Key=${EXPIRES_TAG},Value=${isoSeconds(expiresAt)}`], z.unknown());
  aws(["ec2", "start-instances", "--instance-ids", vm.id], z.unknown());
  log(`starting ${vm.id}, expires ${isoSeconds(expiresAt)}`);

  waitOnline(vm.id);
  runCommand(vm.id, shutdownCommand(expiresAt));
  const address = await rejoinTailnet(vm.id, name);
  const files = localFiles(name);
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  writeFileSync(files.config, sshEntry(hostAlias(name), vm.id, address, files.knownHosts, resolved));

  log("registering with herdr");
  const machine = registerHerdr(name);
  return report(vm, expiresAt, address, machine);
}

interface Row {
  name: string;
  herdr: string;
  instance: string;
  type: string;
  state: string;
  expiresAt: string;
  remaining: string;
}

// A paused VM's expiry is the one that already stopped it, so it shows none.
// A name wired up here with no instance behind it is one the account's reaper
// terminated. It stays listed until destroy clears the local side.
export function rows(vms: Instance[], local: string[], machines: Machine[], now: Date): Row[] {
  const label = (name: string) => machines.find((machine) => machine.target === hostAlias(name))?.label ?? "";
  const live = vms.map((vm) => ({
    name: vm.name,
    herdr: label(vm.name),
    instance: vm.id,
    type: vm.type,
    state: displayState(vm.state),
    expiresAt: vm.expiresAt && vm.state !== "stopped" ? isoSeconds(vm.expiresAt) : "",
    remaining: vm.expiresAt && vm.state !== "stopped" ? formatMinutes((vm.expiresAt.getTime() - now.getTime()) / 60000) : "",
  }));
  const gone = local
    .filter((name) => !vms.some((vm) => vm.name === name))
    .map((name) => ({ name, herdr: label(name), instance: "", type: "", state: "gone", expiresAt: "", remaining: "" }));
  return [...live, ...gone].sort((a, b) => a.name.localeCompare(b.name));
}

function list(args: string[]): number {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown) throw new UsageError(`unknown list option: ${unknown}`);
  const table = rows(instances(), localNames(), knownMachines(), new Date());
  if (args.includes("--json")) {
    console.log(JSON.stringify(table, null, 2));
    return 0;
  }
  if (table.length === 0) return 0;
  const header: Row = { name: "NAME", herdr: "HERDR", instance: "INSTANCE", type: "TYPE", state: "STATE", expiresAt: "EXPIRES", remaining: "REMAINING" };
  const columns = Object.keys(header) as (keyof Row)[];
  const widths = columns.map((column) => Math.max(...[header, ...table].map((row) => row[column].length)));
  for (const row of [header, ...table]) {
    console.log(columns.map((column, index) => row[column].padEnd(widths[index])).join("  ").trimEnd());
  }
  return 0;
}

// Also the cleanup for a VM that already terminated on its own, so a missing
// instance is not an error while local state remains to remove.
function destroy(args: string[]): number {
  const [name] = args;
  if (!name) throw new UsageError("destroy needs a VM name");
  validateName(name);
  const [vm] = instances(name);
  const files = localFiles(name);
  if (!vm && !existsSync(files.config)) throw new Error(`no VM named ${name}`);
  if (vm) {
    aws(["ec2", "terminate-instances", "--instance-ids", vm.id], z.unknown());
    log(`terminating ${vm.id}`);
  }
  unregisterHerdr(name);
  rmSync(files.config, { force: true });
  rmSync(files.knownHosts, { force: true });
  console.log(`${name} destroyed`);
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = { launch, connect, extend, pause, resume, list, destroy };

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const handler = COMMANDS[command];
  try {
    if (!handler) throw new UsageError(`unknown command: ${command}`);
    return await handler(args);
  } catch (error) {
    log((error as Error).message);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
