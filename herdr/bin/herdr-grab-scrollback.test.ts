import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists,
  repoRoot,
  resolveOnPath,
  run,
  sandbox,
  type Sandbox,
} from "../../scripts/lib/shell-fixtures.ts";

const launcher = join(repoRoot, "herdr", "bin", "herdr-grab-scrollback");
const config = join(repoRoot, "herdr", "config.toml");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-grab-scrollback");
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
  expect(resolveOnPath("herdr", "herdr-grab-scrollback")).toBe(realpathSync(launcher));
});

test("binds the launcher by the name PATH exports", () => {
  expect(readFileSync(config, "utf8")).toContain('command = "herdr-grab-scrollback"');
});

test("refuses without herdr on PATH", () => {
  const r = run(["bash", launcher], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

// A stub herdr whose `pane read` echoes the arguments it was handed, so a
// test can assert which pane and which capture window the script asked for.
function stubHerdr(paneJson: string): void {
  box.stub(
    "herdr",
    `case "$1 $2" in
"pane current") echo '${paneJson}' ;;
"pane read") echo "$3 $5 $6 $7" ;;
"notification show") echo "$3" >> ${box.path("toasts")} ;;
*) exit 1 ;;
esac`,
  );
  box.stub("pbcopy", `cat > ${box.path("clipboard")}`);
}

// The default capture window is one screen, which drops exactly the log that
// already scrolled past. Losing the flag would still copy something, so only
// asserting on it catches the regression.
test("asks for the whole history rather than the visible screen", () => {
  stubHerdr('{"result":{"pane":{"pane_id":"w9:p2"}}}');
  const r = run(["bash", launcher], { path: [box.bin] });
  expect(r.status).toBe(0);
  expect(box.read("clipboard").trim()).toBe("w9:p2 recent-unwrapped --lines 10000");
});

// Piping a failed read straight through would replace whatever the user was
// holding with nothing, which is worse than doing nothing at all.
test("leaves the clipboard alone when the pane cannot be read", () => {
  stubHerdr('{"result":{"pane":{"pane_id":"w9:p2"}}}');
  box.stub(
    "herdr",
    `case "$1 $2" in
"pane current") echo '{"result":{"pane":{"pane_id":"w9:p2"}}}' ;;
"pane read") exit 1 ;;
"notification show") : ;;
esac`,
  );
  box.write("clipboard", "previous contents\n");
  const r = run(["bash", launcher], { path: [box.bin] });
  expect(r.status).not.toBe(0);
  expect(box.read("clipboard").trim()).toBe("previous contents");
});

// Both used to say "no focused pane", which sends you clicking between panes
// when herdr is the thing that is not answering.
test("tells a server that is down apart from one reporting no focused pane", () => {
  box.stub("herdr", '[ "$1 $2" = "notification show" ] && exit 0\nexit 1');
  const r = run(["bash", launcher], { path: [box.bin] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("herdr is not answering");
});

test("refuses when no pane is focused", () => {
  stubHerdr('{"result":{"pane":null}}');
  const r = run(["bash", launcher], { path: [box.bin] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("no focused pane");
});

// The first jq on PATH can be a mise shim, which needs a pinned version or a
// fallback elsewhere on PATH to resolve, neither of which holds once PATH is
// narrowed to the stub directory below. Take the first candidate that still
// runs with no PATH at all.
function realJq(): string {
  const candidates = run(["bash", "-c", "which -a jq"]).stdout.trim().split("\n").filter(Boolean);
  const working = candidates.find(
    (c) => !c.includes("/mise/") && run([c, "--version"], { onlyPath: [] }).status === 0,
  );
  if (!working) throw new Error("no jq on PATH that runs standalone");
  return working;
}

// Nothing in this repo installs wl-copy or xclip, so without an example naming
// them the fallback order is only ever exercised on a machine that already has
// one, which is the machine least able to report a break.
test("falls back past pbcopy to whichever clipboard tool the box has", () => {
  stubHerdr('{"result":{"pane":{"pane_id":"w9:p2"}}}');
  rmSync(box.path("bin", "pbcopy"));
  // Absolute /bin/cat, since PATH below holds only the stub directory.
  box.stub("xclip", `echo "xclip $*" > ${box.path("clipboard")}\n/bin/cat >> ${box.path("clipboard")}`);
  // PATH holds only the stubs, so the system pbcopy cannot win the dispatch.
  // jq is linked in because the script still needs it.
  symlinkSync(realJq(), box.path("bin", "jq"));
  const r = run(["/bin/bash", launcher], { onlyPath: [box.bin] });
  expect(r.status).toBe(0);
  expect(box.read("clipboard").split("\n")[0]).toBe("xclip -selection clipboard");
});

test("raises a toast, since a detached keypress has nowhere else to report", () => {
  stubHerdr('{"result":{"pane":null}}');
  run(["bash", launcher], { path: [box.bin] });
  expect(box.read("toasts")).toContain("Grab scrollback failed");
});
