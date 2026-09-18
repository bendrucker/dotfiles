import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { launcherContract } from "#harness/launchers";

// The board ships from the claude repo, which this repo installs but does not
// version, so what a clone missing it does is the case worth pinning.

const launcher = join(repoRoot, "herdr", "bin", "herdr-board");
const config = join(repoRoot, "herdr", "config.toml");
const script = "plugins/herdr/skills/herdr/scripts/board.ts";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-board");
});

afterEach(() => {
  box.remove();
});

launcherContract("herdr", "herdr-board");

test("binds the launcher by the name PATH exports", () => {
  expect(readFileSync(config, "utf8")).toContain('command = "herdr-board"');
});

test("refuses without bun on PATH", () => {
  const r = run(["bash", launcher], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

function stubBun(): void {
  box.stub("bun", 'printf "%s\\n" "$@"');
}

// Absent until the board merges and claude-upgrade syncs it, so the popup opens
// on this line rather than on whatever bun says about a module it cannot find.
test("names the board it could not find", () => {
  stubBun();
  const repo = box.mkdir("claude-repo");

  const r = run(["bash", launcher], { path: [box.bin], env: { CLAUDE_REPO_HOME: repo } });

  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(join(repo, script));
});

// The popup wants the interactive default, and the chief pane's split wants
// --watch, so both reach the board through the same launcher.
test("runs the board with the flags it was handed", () => {
  stubBun();
  const repo = box.mkdir("claude-repo");
  box.write(join("claude-repo", script), "");

  const r = run(["bash", launcher, "--watch"], { path: [box.bin], env: { CLAUDE_REPO_HOME: repo } });

  expect(r.status).toBe(0);
  expect(r.stdout.trim().split("\n")).toEqual([join(repo, script), "--watch"]);
});

test("reports what the board itself failed on", () => {
  box.stub("bun", 'echo "board failed" >&2; exit 3');
  const repo = box.mkdir("claude-repo");
  box.write(join("claude-repo", script), "");

  const r = run(["bash", launcher], { path: [box.bin], env: { CLAUDE_REPO_HOME: repo } });

  expect(r.status).toBe(3);
  expect(r.stderr).toContain("board failed");
});
