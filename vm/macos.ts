import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { APFS_RECOVERY, dropPartitions } from "./gpt.ts";
import { type Check, converge, gitCommonDir, type Guest, type Mode, OLDLAYOUT_COMMIT, Report, verify } from "./guest.ts";
import { errorMessage, type Exit, log, must, POLL_MS, randomName, READY_TIMEOUT_MS, run, until, UsageError } from "./process.ts";

const VANILLA = "ghcr.io/cirruslabs/macos-tahoe-vanilla:latest";
// The image's 50 GB fills partway through the casks. The disk is sparse, so the
// host spends only what the guest writes.
const DISK_GB = "100";
export const IMAGES = { clean: "dotfiles-clean", oldlayout: "dotfiles-oldlayout" } as const;

const SHARES = "/Volumes/My Shared Files";
// Both the CI runner and Cirrus's own agent plist carry Homebrew's bin, and
// scripts/homebrew.sh calls brew right after installing it.
const GUEST_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export const SKIPPED = [
  "mas: no App Store sign-in in a VM, and the Brewfile skips mas without a TTY",
  "Secretive, Touch ID: no Secure Enclave in a VM",
  "TCC grants: they need a click in System Settings",
  "Tailscale and Docker Desktop at runtime: installed, never started",
  "iCloud: no Apple ID in a VM",
];

const CHECKS: Check[] = [
  { name: "tart exec reaches gui/501", cmd: ["sh", "-c", 'launchctl print "gui/$(id -u)" >/dev/null'] },
  { name: "theme-sync agent loaded", cmd: ["sh", "-c", 'launchctl print "gui/$(id -u)/dev.mise.theme-sync" >/dev/null'] },
  { name: "24-hour clock default", cmd: ["sh", "-c", '[ "$(defaults read NSGlobalDomain AppleICUForce24HourTime)" = 1 ]'] },
];

function exists(name: string): boolean {
  return Bun.spawnSync({ cmd: ["tart", "get", name], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

function requireImage(image: string, build: string): void {
  if (!exists(image)) throw new UsageError(`no ${image} VM image: build it with vm-test image ${build}`);
}

class Vm implements Guest {
  readonly share = `${SHARES}/src`;

  constructor(
    readonly name: string,
    private readonly running: Bun.Subprocess,
  ) {}

  exec(cmd: string[], options: { stdin?: Uint8Array; capture?: boolean } = {}): Exit {
    const interactive = options.stdin ? ["-i"] : [];
    const token = process.env.GITHUB_TOKEN ? [`GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`] : [];
    return run(["tart", "exec", ...interactive, this.name, "/usr/bin/env", `PATH=${GUEST_PATH}`, ...token, ...cmd], options);
  }

  stop(): Promise<void> {
    return halt(this.name, this.running, () => this.exec(["sudo", "shutdown", "-h", "now"], { capture: true }));
  }
}

const HALT_MS = Number(process.env.VM_TEST_HALT_MS || 3 * 60 * 1000);

// tart stop does not wait for the guest to flush its disk, so whatever was
// written just before it is lost. The guest shuts itself down first, and tart
// stop only answers a guest that never does.
async function halt(name: string, running: Bun.Subprocess, shutdown: () => unknown): Promise<void> {
  if (running.exitCode === null) shutdown();
  const exited = await Promise.race([running.exited.then(() => true), Bun.sleep(HALT_MS).then(() => false)]);
  if (!exited) run(["tart", "stop", name]);
  await running.exited;
}

function start(name: string, dirs: string[] = []): Bun.Subprocess {
  return Bun.spawn(["tart", "run", "--no-graphics", ...dirs.map((dir) => `--dir=${dir}`), name], { stdout: "inherit", stderr: "inherit" });
}

// The wait yields to the event loop between polls, which is the only way the
// tart run subprocess's exitCode updates, so a VM that never starts fails fast.
async function boot(name: string, dirs: string[]): Promise<Vm> {
  const running = start(name, dirs);
  const vm = new Vm(name, running);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  try {
    while (run(["tart", "exec", name, "true"], { capture: true }).status !== 0) {
      if (running.exitCode !== null) throw new Error(`tart run ${name} exited ${running.exitCode}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name} to answer tart exec`);
      await Bun.sleep(POLL_MS);
    }
  } catch (error) {
    await vm.stop();
    throw error;
  }
  return vm;
}

// Shared from the host so a second run downloads nothing it already has. It is
// a cache of its own, so a guest's Homebrew never writes into the host's.
function brewCache(): string {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "vm-test", "homebrew");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function bootForTest(name: string, root: string): Promise<Vm> {
  const vm = await boot(name, [`src:${gitCommonDir(root)}:ro`, `brewcache:${brewCache()}`]);
  const cache = '"$HOME/Library/Caches/Homebrew"';
  if (vm.exec(["sh", "-c", `mkdir -p "$HOME/Library/Caches" && rm -rf ${cache} && ln -s "${SHARES}/brewcache" ${cache}`]).status !== 0) {
    await vm.stop();
    throw new Error(`could not link ${name}'s Homebrew cache to the host's`);
  }
  return vm;
}

/** Converge a VM cloned from the clean or oldlayout image onto `commit`. */
export async function testMacos(mode: Mode, commit: string, root: string): Promise<Report> {
  const image = mode === "fresh" ? IMAGES.clean : IMAGES.oldlayout;
  requireImage(image, mode === "fresh" ? "clean" : "oldlayout");
  const name = randomName();
  const report = new Report(`vm-test --macos ${mode} ${commit.slice(0, 8)} (${name})`, SKIPPED);
  must(["tart", "clone", image, name]);

  let vm: Vm | undefined;
  try {
    await report.phaseAsync("boot", async () => {
      vm = await bootForTest(name, root);
    });
    if (vm && converge(vm, report, commit)) verify(vm, report, CHECKS);
  } catch (error) {
    log(errorMessage(error));
    report.fail("error");
  }
  await vm?.stop();
  if (report.passed) run(["tart", "delete", name]);
  else log(`kept ${name} for inspection: tart run ${name}, then tart delete ${name}`);
  return report;
}

let askpassPath: string | undefined;

function askpass(): string {
  if (askpassPath) return askpassPath;
  askpassPath = join(mkdtempSync(join(tmpdir(), "vm-test-")), "askpass");
  writeFileSync(askpassPath, "#!/bin/sh\necho admin\n");
  chmodSync(askpassPath, 0o755);
  return askpassPath;
}

// The vanilla image has no guest agent yet, so its preparation goes over SSH
// with the image's documented admin/admin login, answered through SSH_ASKPASS.
function ssh(ip: string, command: string, stdin?: Uint8Array): number {
  const options = ["-F", "/dev/null", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"];
  const password = ["-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive"];
  const result = Bun.spawnSync({
    cmd: ["ssh", ...options, ...password, `admin@${ip}`, command],
    env: { ...process.env, SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: "force" },
    stdin: stdin ?? "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode ?? 128;
}

async function bootsAgain(report: Report, name: string): Promise<void> {
  await report.phaseAsync("boots and answers tart exec", async () => {
    await (await boot(name, [])).stop();
  });
}

function replace(image: string, build: string): void {
  if (exists(image)) must(["tart", "delete", image]);
  must(["tart", "rename", build, image]);
}

function discard(name: string): void {
  if (exists(name)) must(["tart", "delete", name]);
}

// The Recovery partition sits right after the system container, so the
// container cannot grow past it, and SIP refuses to remove it from inside the
// guest. A test VM never boots Recovery, so its entry goes from the GPT on
// the host while the VM is stopped.
function dropRecovery(name: string): void {
  const home = process.env.TART_HOME || join(homedir(), ".tart");
  if (dropPartitions(join(home, "vms", name, "disk.img"), APFS_RECOVERY) === 0) throw new Error(`${name} has no Recovery partition to drop`);
}

async function buildClean(report: Report): Promise<void> {
  const build = `${IMAGES.clean}-build`;
  discard(build);
  must(["tart", "clone", VANILLA, build]);
  dropRecovery(build);
  must(["tart", "set", build, "--disk-size", DISK_GB]);
  const running = start(build);
  let ip = "";
  try {
    ip = must(["tart", "ip", "--wait", "600", build], { capture: true }).trim();
    report.phase("ssh", () => until(`ssh to ${build}`, () => ssh(ip, "true") === 0 || undefined));
    const sudoers = "echo 'admin ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/admin-nopasswd && chmod 440 /etc/sudoers.d/admin-nopasswd";
    report.phase("passwordless sudo", () => ssh(ip, `sudo -S sh -c "${sudoers}"`, new TextEncoder().encode("admin\n")) === 0);
    const prepare = new Uint8Array(readFileSync(join(import.meta.dir, "guest", "clean-image.sh")));
    if (report.passed) report.phase("tools and guest agent", () => ssh(ip, "bash -s", prepare) === 0);
  } finally {
    await halt(build, running, () => ip && ssh(ip, "sudo shutdown -h now"));
  }
  if (report.passed) await bootsAgain(report, build);
  if (report.passed) replace(IMAGES.clean, build);
}

async function buildOldlayout(report: Report, root: string): Promise<void> {
  requireImage(IMAGES.clean, "clean");
  const build = `${IMAGES.oldlayout}-build`;
  discard(build);
  must(["tart", "clone", IMAGES.clean, build]);
  let vm: Vm | undefined;
  await report.phaseAsync("boot", async () => {
    vm = await bootForTest(build, root);
  });
  if (vm) {
    converge(vm, report, OLDLAYOUT_COMMIT);
    await vm.stop();
  }
  if (report.passed) await bootsAgain(report, build);
  if (report.passed) replace(IMAGES.oldlayout, build);
  else log(`kept ${build} for inspection`);
}

/** Build one of the images the test runs clone. */
export async function buildImage(image: keyof typeof IMAGES, root: string): Promise<Report> {
  const report = new Report(`vm-test image ${image}`);
  try {
    if (image === "clean") await buildClean(report);
    else await buildOldlayout(report, root);
  } catch (error) {
    log(errorMessage(error));
    report.fail("error");
  }
  return report;
}
