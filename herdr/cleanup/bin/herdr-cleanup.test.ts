import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, sandbox, type Sandbox } from "#harness";

const script = join(import.meta.dir, "herdr-cleanup");

const REMOTE_ROW = {
  workspaceId: "w9",
  label: "far",
  path: "/far",
  repoRoot: "/r",
  repoName: "repo",
  branch: "far",
  forge: "github",
  pr: { number: 7, state: "MERGED", ref: "repo#7" },
  step: "prune",
  reason: "merged",
  flags: [],
  ignored: [],
};

let box: Sandbox;

// A herdr with no workspaces, so every row on the board came over ssh. The ssh
// stub logs its arguments and answers with whatever `ssh-out` holds.
beforeEach(() => {
  box = sandbox("herdr-cleanup");
  box.stub("herdr", `echo '{"result":{"snapshot":{"workspaces":[],"agents":[]}}}'`);
  box.stub("ssh", `printf '%s\\n' "$*" >>"${box.path("ssh.log")}"\ncat "${box.path("ssh-out")}" 2>/dev/null || exit 255`);
});

afterEach(() => box.remove());

function cleanup(...args: string[]) {
  return run([script, ...args], { path: [box.bin], env: { XDG_STATE_HOME: box.path("state") } });
}

describe("the work machine", () => {
  test("stays off the board until toggled on", () => {
    box.write("ssh-out", JSON.stringify([REMOTE_ROW]));
    const out = cleanup("lines").stdout;
    expect(out).not.toContain("work:");
    expect(out).toContain("herdr live\n");
    expect(box.read("ssh.log")).toBe("");
  });

  test("adds its rows with a machine prefix and keys actions to it", () => {
    box.write("ssh-out", JSON.stringify([REMOTE_ROW, { label: "malformed" }]));
    cleanup("toggle-machine");
    const out = cleanup("lines").stdout;
    expect(out).toContain("work:w9\t→ prune  work:far  repo#7  merged");
    expect(out).not.toContain("malformed");
    expect(box.read("ssh.log")).toContain("work ~/.dotfiles/herdr/cleanup/bin/herdr-cleanup rows --json");
  });

  test("says it is unreachable when ssh fails", () => {
    cleanup("toggle-machine");
    expect(cleanup("lines").stdout).toContain("herdr live · work unreachable");
  });

  test("toggles back off", () => {
    cleanup("toggle-machine");
    cleanup("toggle-machine");
    expect(existsSync(box.path("state", "dotfiles", "herdr-cleanup-machines"))).toBe(false);
  });

  test("runs a remote row's action on that machine", () => {
    box.write("ssh-out", "");
    expect(cleanup("prune", "work:w9").status).toBe(0);
    expect(box.read("ssh.log")).toBe("-t work ~/.dotfiles/herdr/cleanup/bin/herdr-cleanup prune w9\n");
  });
});

test("names a local workspace it cannot find", () => {
  const result = cleanup("prune", "w404");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no worktree workspace w404");
});
