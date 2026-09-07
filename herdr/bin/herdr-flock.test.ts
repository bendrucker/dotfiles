import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists,
  repoRoot,
  resolveOnPath,
  run,
  sandbox,
  shell,
  type Sandbox,
} from "../../scripts/lib/shell-fixtures.ts";

const launcher = join(repoRoot, "herdr", "bin", "herdr-flock");
const config = join(repoRoot, "herdr", "config.toml");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-flock");
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
  expect(resolveOnPath("herdr", "herdr-flock")).toBe(realpathSync(launcher));
});

// The prefix+alt+f binding is the only [[keys.command]] block naming this
// launcher.
function flockBinding(): string {
  const blocks = readFileSync(config, "utf8").split("\n\n");
  const block = blocks.find((b) => b.includes('key = "prefix+alt+f"'));
  if (!block) throw new Error("no prefix+alt+f binding in config.toml");
  const match = block.match(/^command = "(.*)"$/m);
  if (!match) throw new Error("no command line in the prefix+alt+f binding");
  return match[1];
}

// The server holds the environment it started with for as long as it runs, so
// a bare name resolves against a PATH that can predate herdr/path.zsh.
// Expanded here the way herdr expands it, with herdr/bin off PATH.
test("binds the launcher by a path rather than a name PATH has to resolve", () => {
  const r = shell(`echo ${flockBinding()}`, { onlyPath: ["/usr/bin", "/bin"], env: { ZSH: repoRoot } });
  expect(realpathSync(r.stdout.trim())).toBe(realpathSync(launcher));
});

// A prefix that can expand to nothing would leave an absolute path rooted at
// /, silently resolving to the wrong location.
test("falls back to the installed root when the server carries no $ZSH", () => {
  const r = shell(`echo ${flockBinding()}`, { env: { ZSH: undefined } });
  expect(r.stdout.trim()).toBe(`${process.env.HOME}/.dotfiles/herdr/bin/herdr-flock`);
});

test("refuses without herdr on PATH", () => {
  const r = run(["bash", launcher], { onlyPath: ["/usr/bin", "/bin"] });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not on PATH");
});

// Two keypresses race the lookup against the create. The loser must not
// build its own workspace under the same label.
test("yields to a concurrent launch instead of seating a second flock", () => {
  box.mkdir("herdr-flock.lock");
  box.write("snapshot.json", '{"result":{"snapshot":{"workspaces":[]}}}\n');
  box.stub(
    "herdr",
    `[ "$1 $2" = "api snapshot" ] && exec cat ${box.path("snapshot.json")}
echo "stub herdr: refused $*" >&2
exit 1`,
  );
  const r = run(["bash", launcher], { path: [box.bin], env: { TMPDIR: box.dir } });
  const output = r.stdout + r.stderr;
  expect(r.status).not.toBe(0);
  expect(output).toContain("another launch holds the lock");
  expect(output).not.toContain("refused workspace create");
});

test("retries agent start once while the pane reaches its prompt", () => {
  box.write("snapshot.json", '{"result":{"snapshot":{"workspaces":[]}}}\n');
  box.write("created.json", '{"result":{"root_pane":{"pane_id":"w9:p1"}}}\n');
  box.stub(
    "herdr",
    `case "$1 $2" in
"api snapshot") cat ${box.path("snapshot.json")} ;;
"workspace create") cat ${box.path("created.json")} ;;
"agent start")
  n=$(cat ${box.path("tries")} 2>/dev/null || echo 0)
  echo $((n + 1)) > ${box.path("tries")}
  [ "$n" = "0" ] && exit 1
  ;;
"agent prompt") echo sent > ${box.path("prompted")} ;;
*) exit 1 ;;
esac
exit 0`,
  );
  const r = run(["bash", launcher], { path: [box.bin], env: { TMPDIR: box.dir } });
  expect(r.status).toBe(0);
  expect(box.read("tries").trim()).toBe("2");
  expect(box.read("prompted")).not.toBe("");
});
