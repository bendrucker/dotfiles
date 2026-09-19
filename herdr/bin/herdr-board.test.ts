import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, shell, type Sandbox } from "#harness";
import { launcherContract } from "#harness/launchers";

// The claude repo is installed here but not version-pinned, so a clone can be
// missing the board script.

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

// The prefix+alt+b binding is the only [[keys.command]] block naming this
// launcher.
function boardBinding(): string {
  const blocks = readFileSync(config, "utf8").split("\n\n");
  const block = blocks.find((b) => b.includes('key = "prefix+alt+b"'));
  if (!block) throw new Error("no prefix+alt+b binding in config.toml");
  const match = block.match(/^command = "(.*)"$/m);
  if (!match) throw new Error("no command line in the prefix+alt+b binding");
  return match[1];
}

// The server holds the environment it started with for as long as it runs, so
// a bare name resolves against a PATH that can predate herdr/path.zsh.
// Expanded here the way herdr expands it, with herdr/bin off PATH.
test("binds the launcher by a path rather than a name PATH has to resolve", () => {
  const r = shell(`echo ${boardBinding()}`, { onlyPath: ["/usr/bin", "/bin"], env: { ZSH: repoRoot } });
  expect(realpathSync(r.stdout.trim())).toBe(realpathSync(launcher));
});

// A prefix that can expand to nothing would leave an absolute path rooted at
// /, silently resolving to the wrong location.
test("falls back to the installed root when the server carries no $ZSH", () => {
  const r = shell(`echo ${boardBinding()}`, { env: { ZSH: undefined } });
  expect(r.stdout.trim()).toBe(`${process.env.HOME}/.dotfiles/herdr/bin/herdr-board`);
});

test("refuses without bun on PATH", () => {
  const r = run(["bash", launcher], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

function stubBun(): void {
  box.stub("bun", 'printf "%s\\n" "$@"');
}

// The script is missing until the board merges and syncs. This pins the
// launcher's own one-line error for that case.
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
