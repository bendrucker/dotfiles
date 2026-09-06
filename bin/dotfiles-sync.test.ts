import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run as the launchd job runs it, so the exit status, the log, and the
// notification are read off the real script rather than off its parts.
const script = join(import.meta.dir, "dotfiles-sync");

let sandbox: string;
let stubs: string;
let repo: string;
let origin: string;

const parentPath = process.env.PATH;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function sync(...args: string[]): Run {
  const spawned = Bun.spawnSync({
    cmd: [script, ...args],
    env: {
      ...process.env,
      PATH: `${stubs}:${parentPath}`,
      DOTFILES_HOME: repo,
      RELOAD_LOG: join(sandbox, "reload.log"),
      BOOTSTRAP_LOG: join(sandbox, "bootstrap.log"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function readLog(name: string): string {
  try {
    return readFileSync(join(sandbox, name), "utf8");
  } catch {
    return "";
  }
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
}

// Land a commit on origin that the clone has not pulled, optionally carrying a
// .gitignore rule this checkout has no way to know about yet.
function pushCommit(rule?: string): void {
  const upstream = join(sandbox, "upstream");
  rmSync(upstream, { recursive: true, force: true });
  run(["git", "clone", "-q", origin, upstream]);
  run(["git", "-C", upstream, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", upstream, "config", "user.name", "Spec"]);
  run(["git", "-C", upstream, "config", "commit.gpgsign", "false"]);
  if (rule !== undefined) writeFileSync(join(upstream, ".gitignore"), `${rule}\n`);
  writeFileSync(join(upstream, "landed.txt"), "landed\n");
  run(["git", "-C", upstream, "add", "-A"]);
  run(["git", "-C", upstream, "commit", "-q", "-m", "landed"]);
  run(["git", "-C", upstream, "push", "-q", "origin", "main"]);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "dotfiles-sync-"));
  stubs = join(sandbox, "stub");
  repo = join(sandbox, "repo");
  origin = join(sandbox, "origin.git");
  mkdirSync(stubs);

  // gum prefixes each line with the level, as the real gum does with no --time
  // set, because the fingerprint the nightly report latches on is read off that
  // prefix.
  writeScript(
    join(stubs, "gum"),
    [
      'case "$1" in',
      "  spin)",
      "    shift",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    [ "$1" = "--" ] && shift',
      '    exec "$@"',
      "    ;;",
      "  log)",
      '    case "$3" in',
      "      warn)  level=WARN ;;",
      "      error) level=ERRO ;;",
      "      *)     level=INFO ;;",
      "    esac",
      '    printf "%s %s\\n" "$level" "${@: -1}" >&2',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );

  writeScript(join(stubs, "osascript"), `printf '%s\\n' "$2" >>"${join(sandbox, "notifications")}"`);
  writeScript(join(stubs, "open"), `printf 'todo\\n' >>"${join(sandbox, "todos")}"`);

  run(["git", "init", "-q", "--bare", "-b", "main", origin]);
  run(["git", "init", "-q", "-b", "main", repo]);
  run(["git", "-C", repo, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", repo, "config", "user.name", "Spec"]);
  run(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  // So an example can take the executable bit off a tracked script without the
  // gate seeing a modified file.
  run(["git", "-C", repo, "config", "core.fileMode", "false"]);
  run(["git", "-C", repo, "remote", "add", "origin", origin]);

  writeFileSync(join(repo, "file.txt"), "tracked\n");
  mkdirSync(join(repo, "bin"));
  mkdirSync(join(repo, "scripts"));
  writeScript(
    join(repo, "bin", "dotfiles-reload"),
    ['printf \'reloaded\\n\' >>"$RELOAD_LOG"', 'exit "${RELOAD_STATUS:-0}"'].join("\n"),
  );
  writeScript(join(repo, "scripts", "bootstrap"), `printf '%s\\n' "$*" >>"$BOOTSTRAP_LOG"`);

  run(["git", "-C", repo, "add", "-A"]);
  run(["git", "-C", repo, "commit", "-q", "-m", "initial"]);
  run(["git", "-C", repo, "push", "-q", "-u", "origin", "main"]);
  run(["git", "-C", repo, "remote", "set-head", "origin", "main"]);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// Under the shell's `set -e`, the already-current path (git_sync returns 2) had
// to map to exit 0 rather than abort the script with the raw "current" code.
test("exits 0 when the repo is already up to date", () => {
  const result = sync();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("Already up to date");
  expect(readLog("reload.log")).toBe("");
});

// A dirty working tree is caught before the sync. Without a terminal it renders
// the diff, notifies, and aborts.
test("exits 1 when the working tree is dirty", () => {
  writeFileSync(join(repo, "dirty"), "");
  run(["git", "-C", repo, "add", "dirty"]);

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Local changes present");
  expect(readLog("notifications")).toContain("Skipped: local changes present");
});

// The rule and the files it covers ship in the same commit, so the rule can only
// reach this checkout through the pull the gate is blocking. Judged against the
// .gitignore on disk the tree stays dirty every night forever.
test("syncs past an untracked path the incoming .gitignore covers", () => {
  pushCommit("scratch/");
  mkdirSync(join(repo, "scratch"));
  writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

  const result = sync();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("ignored by the incoming .gitignore");
});

// .gitignore says nothing about a path git already tracks, so nothing the pull
// carries may wave one through.
test("still blocks a tracked modification", () => {
  pushCommit("scratch/");
  writeFileSync(join(repo, "file.txt"), "edited\n");

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Local changes present");
});

test("still blocks an untracked path neither .gitignore covers", () => {
  pushCommit("scratch/");
  writeFileSync(join(repo, "stray.txt"), "stray\n");

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Local changes present");
});

// `git diff HEAD` names no untracked file, so the report of a block over one used
// to carry an empty diff.
test("renders the diff of an untracked file", () => {
  writeFileSync(join(repo, "stray.txt"), "stray\n");

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("+++ b/stray.txt");
  expect(result.stderr).toContain("+stray");
});

// The nightly report fingerprints on fields 2-4 of the WARN and ERRO lines, and
// "Local changes present - skipping sync" reads the same whatever is dirty. The
// paths need a line of their own, or a block recurring over a different dirty set
// files no to-do after the first and the deadlock goes silent.
test("puts the blocking paths in fields 2-4 of a line of their own", () => {
  writeFileSync(join(repo, "stray.txt"), "stray\n");

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("WARN stray.txt");
});

test("exits 1 and notifies when the sync itself fails", () => {
  const notARepo = join(sandbox, "not-a-repo");
  mkdirSync(notARepo);

  const result = Bun.spawnSync({
    cmd: [script],
    env: { ...process.env, PATH: `${stubs}:${parentPath}`, DOTFILES_HOME: notARepo },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(readLog("notifications")).toContain("Failed: could not sync");
});

test("reloads the running config and notifies once the pull moved the tree", () => {
  pushCommit();

  const result = sync();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("Successfully updated to");
  expect(readLog("reload.log")).toBe("reloaded\n");
  expect(readLog("notifications")).toContain("Updated to");
  expect(existsSync(join(repo, "landed.txt"))).toBe(true);
});

// The sync it follows has already succeeded, and stale in-memory config resolves
// itself the next time the program starts.
test("downgrades a failing reload to a warning", () => {
  pushCommit();

  const result = Bun.spawnSync({
    cmd: [script],
    env: {
      ...process.env,
      PATH: `${stubs}:${parentPath}`,
      DOTFILES_HOME: repo,
      RELOAD_LOG: join(sandbox, "reload.log"),
      RELOAD_STATUS: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("WARN some config reloads had issues");
});

test("exits 1 and notifies when the submodule update fails", () => {
  pushCommit();
  const realGit = Bun.which("git", { PATH: parentPath });
  if (realGit === null) throw new Error("git is not on PATH");
  writeScript(
    join(stubs, "git"),
    [
      'for a in "$@"; do',
      '  [ "$a" = submodule ] && exit 1',
      "done",
      `exec ${realGit} "$@"`,
    ].join("\n"),
  );

  const result = sync();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("ERRO Submodule update failed");
  expect(readLog("notifications")).toContain("Failed: submodules");
  expect(readLog("reload.log")).toBe("");
});

// The symlink refresh is opt-in, and the launchd job skips it. Bootstrap reaches
// the reload through scripts/install once its own changes are in place, so this
// path must not run the reload itself.
test("--bootstrap re-runs bootstrap instead of the reload", () => {
  pushCommit();

  const result = sync("--bootstrap");
  expect(result.status).toBe(0);
  expect(readLog("bootstrap.log")).toBe("--no-prompt\n");
  expect(readLog("reload.log")).toBe("");
});

// The shell fell through to the reload when the bootstrap script was not
// executable, so a caller that asked for a symlink refresh got a config reload
// and was told it had succeeded.
test("--bootstrap fails rather than falling through to the reload", () => {
  pushCommit();
  chmodSync(join(repo, "scripts", "bootstrap"), 0o644);

  const result = sync("--bootstrap");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("is not executable - cannot bootstrap");
  expect(readLog("bootstrap.log")).toBe("");
  expect(readLog("reload.log")).toBe("");
});

// Unknown arguments have never meant anything here.
test("treats an unrecognized argument as a plain sync", () => {
  pushCommit();

  const result = sync("--nonsense");
  expect(result.status).toBe(0);
  expect(readLog("reload.log")).toBe("reloaded\n");
  expect(readLog("bootstrap.log")).toBe("");
});
