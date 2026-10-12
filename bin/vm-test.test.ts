import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { must, repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";
import { APFS_RECOVERY, dropPartitions } from "../vm/gpt.ts";
import { writeGptImage } from "../vm/gpt-fixture.ts";
import { OLDLAYOUT_COMMIT } from "../vm/guest.ts";

const vmTest = join(repoRoot, "bin", "vm-test");

let box: Sandbox;

// What a guest command does under any stub: a shutdown ends the running VM
// unless $HANG is set,
// a script on stdin is links.sh when it reads links, a command matching
// $FAIL_ON exits 1, and $MOVE_LINK makes every links snapshot differ from the
// one before.
const GUEST = `
input=""
if [ "$interactive" = 1 ]; then input=$(cat); fi
case "$*" in *"shutdown -h now"*) [ -n "$HANG" ] || kill "$(cat "$STATE/run.pid")" 2>/dev/null ;; esac
case "$*" in *"$FAIL_ON"*) [ -n "$FAIL_ON" ] && exit 1 ;; esac
case "$input" in
  *readlink*)
    [ -n "$MOVE_LINK" ] && echo "/home/.moved -> $(cat "$STATE/links" 2>/dev/null | wc -l | tr -d ' ')" >>"$STATE/links"
    cat "$STATE/links" 2>/dev/null
    ;;
esac
exit 0
`;

beforeEach(() => {
  box = sandbox("vm-test");
  box.write("state/images", "dotfiles-clean\ndotfiles-oldlayout\n");
  box.write("guest.sh", GUEST);
  box.stub(
    "tart",
    `echo "tart $*" >>"$STATE/log"
case "$1" in
  get) grep -qx "$2" "$STATE/images" ;;
  clone) echo "$3" >>"$STATE/images" ;;
  rename) echo "$3" >>"$STATE/images" ;;
  delete) grep -vx "$2" "$STATE/images" >"$STATE/images.new"; mv "$STATE/images.new" "$STATE/images" ;;
  ip) echo 192.0.2.10 ;;
  run) [ -n "$RUN_EXITS" ] && exit 1; echo $$ >"$STATE/run.pid"; exec sleep 60 ;;
  stop) kill "$(cat "$STATE/run.pid")" 2>/dev/null; exit 0 ;;
  exec)
    shift; interactive=0
    if [ "$1" = -i ]; then interactive=1; shift; fi
    shift
    . "$STATE/../guest.sh"
    ;;
esac`,
  );
  box.stub(
    "docker",
    `echo "docker $*" >>"$STATE/log"
case "$1" in
  run) echo 0123456789ab ;;
  exec)
    interactive=0
    case "$*" in *--interactive*) interactive=1 ;; esac
    . "$STATE/../guest.sh"
    ;;
esac`,
  );
  box.stub("ssh", `echo "ssh $*" >>"$STATE/log"\ninteractive=1\n. "$STATE/../guest.sh"`);
});

afterEach(() => {
  box.remove();
});

function vm(args: string[], env: Record<string, string> = {}): Run {
  return run([vmTest, ...args], {
    path: [box.bin],
    env: { STATE: box.path("state"), VM_POLL_MS: "1", VM_TEST_HALT_MS: "2000", XDG_CACHE_HOME: box.path("cache"), ...env },
  });
}

function calls(prefix: string): string[] {
  return box
    .read("state/log")
    .split("\n")
    .filter((line) => line.startsWith(prefix));
}

const head = must(["git", "-C", repoRoot, "rev-parse", "HEAD"]).trim();
const commonDir = must(["git", "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();

describe("vm-test --macos", () => {
  test("installs twice in a clone of the clean image, checks it, and deletes it", () => {
    const r = vm(["--macos", "fresh"]);
    expect(r.status).toBe(0);

    const clone = calls("tart clone")[0];
    expect(clone).toMatch(/^tart clone dotfiles-clean vm-test-[0-9a-f]{6}$/);
    const name = clone.split(" ")[3];
    expect(calls("tart run")[0]).toContain(`--dir=src:${commonDir}:ro`);
    expect(calls("tart exec").filter((line) => line.includes("scripts/setup"))).toHaveLength(2);
    expect(calls(`tart exec -i ${name}`).some((line) => line.includes(`/Volumes/My Shared Files/src ${head}`))).toBe(true);
    expect(calls("tart delete")).toEqual([`tart delete ${name}`]);

    expect(r.stdout).toContain(`vm-test --macos fresh ${head.slice(0, 8)} (${name}): passed`);
    expect(r.stdout).toContain("tart exec reaches gui/501");
    expect(r.stdout).toContain("skipped mas");
  });

  test("starts an upgrade from the oldlayout image", () => {
    expect(vm(["--macos", "upgrade", "--ref", "HEAD"]).status).toBe(0);
    expect(calls("tart clone")[0]).toMatch(/^tart clone dotfiles-oldlayout /);
  });

  test("keeps the VM and fails when setup fails", () => {
    const r = vm(["--macos", "fresh"], { FAIL_ON: "scripts/setup" });
    expect(r.status).toBe(1);
    expect(calls("tart delete")).toEqual([]);
    expect(calls("tart exec").filter((line) => line.endsWith("sudo shutdown -h now"))).toHaveLength(1);
    expect(r.stderr).toContain("kept vm-test-");
    expect(r.stdout).toMatch(/FAILED {2}setup [0-9a-f]{8}/);
  });

  test("fails when the second run moves a link, naming it", () => {
    const r = vm(["--macos", "fresh"], { MOVE_LINK: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAILED  second run moved no link");
    expect(r.stderr).toContain("/.moved -> ");
  });

  test("fails a check without stopping the rest", () => {
    const r = vm(["--macos", "fresh"], { FAIL_ON: "dev.mise.theme-sync" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAILED  theme-sync agent loaded");
    expect(r.stdout).toContain("passed  24-hour clock default");
  });

  test("fails the boot at once when tart run exits", () => {
    const r = vm(["--macos", "fresh"], { RUN_EXITS: "1", FAIL_ON: "true", VM_POLL_MS: "50" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/tart run vm-test-[0-9a-f]{6} exited 1/);
  });

  test("stops a VM that does not shut itself down", () => {
    expect(vm(["--macos", "fresh"], { HANG: "1", VM_TEST_HALT_MS: "100" }).status).toBe(0);
    expect(calls("tart stop")).toHaveLength(1);
  });

  test("names the image command when the clean image is missing", () => {
    box.write("state/images", "");
    const r = vm(["--macos", "fresh"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("vm-test image clean");
    expect(calls("tart clone")).toEqual([]);
  });
});

describe("vm-test --linux", () => {
  test("installs twice in an ubuntu container as runner, then removes it", () => {
    const r = vm(["--linux", "fresh", "--ref", "HEAD"]);
    expect(r.status).toBe(0);

    const started = calls("docker run")[0];
    expect(started).toContain(`--volume ${commonDir}:/src:ro`);
    expect(started).toContain("ubuntu:24.04 sleep infinity");
    const name = started.split(" ")[4];
    const asRunner = calls("docker exec").filter((line) => line.includes("--user runner"));
    expect(asRunner.filter((line) => line.includes("scripts/setup"))).toHaveLength(2);
    expect(calls("docker rm")).toEqual([`docker rm --force ${name}`]);
    expect(r.stdout).toContain("passed  prepare runner");
  });

  test("passes GITHUB_TOKEN by name only", () => {
    expect(vm(["--linux", "fresh"], { GITHUB_TOKEN: "secret-token" }).status).toBe(0);
    const setups = calls("docker exec").filter((line) => line.includes("scripts/setup"));
    expect(setups.every((line) => line.includes("--env GITHUB_TOKEN "))).toBe(true);
    expect(box.read("state/log")).not.toContain("secret-token");
  });

  test("installs the old layout before the commit under test on upgrade", () => {
    expect(vm(["--linux", "upgrade"]).status).toBe(0);
    const seeded = calls("docker exec --interactive --user runner")
      .map((line) => line.match(/\/src ([0-9a-f]{40})$/)?.[1])
      .filter(Boolean);
    expect(seeded).toEqual([OLDLAYOUT_COMMIT, head]);
  });

  test("keeps the container when setup fails", () => {
    const r = vm(["--linux", "fresh"], { FAIL_ON: "scripts/setup" });
    expect(r.status).toBe(1);
    expect(calls("docker rm")).toEqual([]);
    expect(r.stderr).toContain("docker rm -f vm-test-");
  });
});

describe("vm-test image", () => {
  test("clean prepares the vanilla image over ssh and renames the build", () => {
    box.write("state/images", "");
    const disk = box.path("tart/vms/dotfiles-clean-build/disk.img");
    mkdirSync(dirname(disk), { recursive: true });
    writeGptImage(disk, [APFS_RECOVERY]);
    const r = vm(["image", "clean"], { TART_HOME: box.path("tart") });
    expect(r.status).toBe(0);
    expect(dropPartitions(disk, APFS_RECOVERY)).toBe(0);
    expect(calls("tart clone")).toEqual(["tart clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest dotfiles-clean-build"]);
    expect(calls("tart set")).toEqual(["tart set dotfiles-clean-build --disk-size 100"]);
    expect(calls("ssh").some((line) => line.endsWith("admin@192.0.2.10 bash -s"))).toBe(true);
    expect(calls("tart rename")).toEqual(["tart rename dotfiles-clean-build dotfiles-clean"]);
  });

  test("oldlayout installs the pinned commit into a clone of clean", () => {
    const r = vm(["image", "oldlayout"]);
    expect(r.status).toBe(0);
    expect(calls("tart clone")).toEqual(["tart clone dotfiles-clean dotfiles-oldlayout-build"]);
    expect(calls("tart exec -i").some((line) => line.endsWith(OLDLAYOUT_COMMIT))).toBe(true);
    expect(calls("tart exec").filter((line) => line.includes("scripts/setup"))).toHaveLength(1);
    expect(calls("tart delete")).toEqual(["tart delete dotfiles-oldlayout"]);
    expect(calls("tart rename")).toEqual(["tart rename dotfiles-oldlayout-build dotfiles-oldlayout"]);
  });
});

test.each<{ name: string; args: string[] }>([
  { name: "no arguments", args: [] },
  { name: "no mode", args: ["--macos"] },
  { name: "no platform", args: ["fresh"] },
  { name: "an unknown mode", args: ["--linux", "sideways"] },
  { name: "an unknown image", args: ["image", "dirty"] },
  { name: "a ref that is no commit", args: ["--linux", "fresh", "--ref", "no-such-ref"] },
])("exits 2 with usage for $name", ({ args }) => {
  const r = vm(args);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("Usage: vm-test");
  expect(box.read("state/log")).toBe("");
});
