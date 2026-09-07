import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists,
  repoRoot,
  resolveOnPath,
  run,
  sandbox,
  type Sandbox,
} from "../../scripts/lib/shell-fixtures.ts";

const launcher = join(repoRoot, "herdr", "bin", "herdr-claude-agents");
const config = join(repoRoot, "herdr", "config.toml");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-claude-agents");
});

afterEach(() => {
  box.remove();
});

test("is executable", () => {
  expect(statSync(launcher).mode & 0o111).not.toBe(0);
});

test.skipIf(!commandExists("shellcheck"))("passes shellcheck", () => {
  expect(run(["shellcheck", launcher]).status).toBe(0);
});

// path.zsh is one of the two files .zshrc skips, so sourcing it under a chosen
// $ZSH root is what a login shell does to it. -f keeps the installed root out,
// which is what makes this test the worktree rather than ~/.dotfiles.
test("is reachable on PATH from a login shell", () => {
  expect(resolveOnPath("herdr", "herdr-claude-agents")).toBe(realpathSync(launcher));
});

test("binds the launcher by the name PATH exports", () => {
  expect(readFileSync(config, "utf8")).toContain('command = "herdr-claude-agents"');
});

test("refuses without claude on PATH", () => {
  const r = run(["bash", launcher], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

function stubClaude(): void {
  box.stub("claude", 'echo "$*"');
}

// The view dispatches sessions, and each one inherits only the dirs named
// here, so a dropped entry silently narrows what those sessions may read.
test("folds every CLAUDE_AGENTS_ADD_DIR entry into its own --add-dir", () => {
  stubClaude();
  const r = run(["bash", launcher], { path: [box.bin], env: { CLAUDE_AGENTS_ADD_DIR: "/a:/b" } });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("agents --add-dir /a --add-dir /b");
});

test("drops the empty entry a trailing colon leaves behind", () => {
  stubClaude();
  const r = run(["bash", launcher], { path: [box.bin], env: { CLAUDE_AGENTS_ADD_DIR: "/a:" } });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("agents --add-dir /a");
});

test("passes no flags when the variable is unset", () => {
  stubClaude();
  const r = run(["bash", launcher], { path: [box.bin], env: { CLAUDE_AGENTS_ADD_DIR: undefined } });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("agents");
});
