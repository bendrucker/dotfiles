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

const launcher = join(repoRoot, "herdr", "bin", "herdr-attach");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-attach");
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
  expect(resolveOnPath("herdr", "herdr-attach")).toBe(realpathSync(launcher));
});

test("refuses without herdr on PATH", () => {
  const r = run(["bash", launcher, "anything"], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

// The whole point of this launcher is that it never becomes a second full app
// client, which is what turns off herdr's direct-kitty graphics for the
// desktop and silently breaks the mouse in terminal-browser and tode panes.
// `terminal attach` connects in a mode the client count excludes. Plain
// `herdr` does not.
test("attaches over the terminal path rather than starting an app client", () => {
  expect(readFileSync(launcher, "utf8")).toMatch(/^exec herdr terminal attach/m);
});

function stubHerdr(): void {
  box.stub(
    "herdr",
    `case "$1 $2" in
  "pane list")
    printf '%s' '{"result":{"panes":[
      {"pane_id":"wA:p1","terminal_id":"term_a","agent_status":"idle","terminal_title_stripped":"a shell"},
      {"pane_id":"wB:p1","terminal_id":"term_b","agent_status":"done","terminal_title_stripped":"an agent"}]}}'
    ;;
  "agent list")
    printf '%s' '{"result":{"agents":[{"pane_id":"wB:p1","name":"shipper"}]}}'
    ;;
  "terminal attach")
    shift 2
    echo "attach $*"
    ;;
esac`,
  );
}

function attach(...args: string[]) {
  return run(["bash", launcher, ...args], { path: [box.bin] });
}

// The name is the only handle worth typing on a phone keyboard, and it
// lives on the agent list rather than the pane list.
test("resolves an agent name to that agent's terminal", () => {
  stubHerdr();
  const r = attach("shipper");
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("attach term_b");
});

test("resolves a pane id", () => {
  stubHerdr();
  const r = attach("wA:p1");
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("attach term_a");
});

test("resolves a terminal id", () => {
  stubHerdr();
  const r = attach("term_b");
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("attach term_b");
});

// A dropped mosh link leaves its client holding the terminal, so reclaiming
// one is the ordinary case rather than the exception.
test("passes --takeover through", () => {
  stubHerdr();
  const r = attach("--takeover", "shipper");
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("attach term_b --takeover");
});

test("rejects a target matching no pane, terminal, or agent", () => {
  stubHerdr();
  const r = attach("nonesuch");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no pane id, terminal id, or agent name");
});

test("reports a server that is not running", () => {
  box.stub("herdr", "exit 1");
  const r = attach("shipper");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no herdr server is running");
});
