import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISCARD,
  OPEN_PR,
  SKIP,
  capturableContent,
  changesNameHost,
  defaultBranch,
  hostNames,
  httpsEnv,
  lines,
  openPr,
  renderDiff,
  reviewBlocking,
  reviewDirty,
  stripNewlines,
  syncNotify,
} from "#jobs/sync-gate";
import type { Capture, SpawnOptions } from "#jobs/output";

let sandbox: string;
let stubs: string;
let repo: string;
let origin: string;
let out: Capture;

const environment = {
  PATH: process.env.PATH,
  GUM_CHOICE: process.env.GUM_CHOICE,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

// httpsEnv reads and extends whatever GIT_CONFIG_* the run already carries, so
// the examples over it edit the real environment and have to put it back.
let gitConfigEnvironment: [string, string][] = [];

function gitConfigKeys(): string[] {
  return Object.keys(process.env).filter((key) => key.startsWith("GIT_CONFIG_"));
}

// Every branch under test is a sequence of real git commands, so the children run
// for real. What they write is kept rather than let through to the test runner's
// own streams, which is also how an example reads the log the job produced.
function recording(): Capture {
  const chunks: string[] = [];
  const keep = (text: string): void => {
    if (text !== "") chunks.push(text);
  };

  const spawn = (
    cmd: string[],
    options?: SpawnOptions,
  ): { status: number; stdout: string; stderr: string } => {
    try {
      const run = Bun.spawnSync({
        cmd,
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: run.exitCode,
        stdout: run.stdout.toString(),
        stderr: run.stderr.toString(),
      };
    } catch {
      return { status: 127, stdout: "", stderr: "" };
    }
  };

  return {
    write(_fd, text) {
      keep(text);
    },
    run(cmd, options) {
      const result = spawn(cmd, options);
      keep(result.stdout);
      keep(result.stderr);
      return result.status;
    },
    read(cmd, options) {
      const result = spawn(cmd, options);
      keep(result.stderr);
      return { status: result.status, stdout: result.stdout };
    },
    captured() {
      return chunks.join("");
    },
  };
}

function writeStub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
}

function git(...args: string[]): { status: number; stdout: string } {
  const run = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: run.exitCode, stdout: run.stdout.toString() };
}

function notifications(): string {
  try {
    return readFileSync(join(sandbox, "notifications"), "utf8");
  } catch {
    return "";
  }
}

function ghLog(): string {
  try {
    return readFileSync(join(sandbox, "gh.log"), "utf8");
  } catch {
    return "";
  }
}

// Land a commit on origin the clone has not pulled, so origin/<branch> carries a
// rule this checkout has no way to know about yet.
function pushIgnoreRule(rule: string): void {
  const upstream = join(sandbox, "upstream");
  rmSync(upstream, { recursive: true, force: true });
  run(["git", "clone", "-q", origin, upstream]);
  // Its own identity and signing setting: the clone inherits neither from the
  // fixture repo, and a runner with no global gitconfig cannot commit at all.
  run(["git", "-C", upstream, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", upstream, "config", "user.name", "Spec"]);
  run(["git", "-C", upstream, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(upstream, ".gitignore"), `${rule}\n`);
  run(["git", "-C", upstream, "add", ".gitignore"]);
  run(["git", "-C", upstream, "commit", "-q", "-m", `ignore ${rule}`]);
  run(["git", "-C", upstream, "push", "-q", "origin", "main"]);
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "sync-gate-"));
  stubs = join(sandbox, "stub");
  repo = join(sandbox, "repo");
  origin = join(sandbox, "origin.git");
  mkdirSync(stubs);
  process.env.XDG_STATE_HOME = join(sandbox, "state");

  // The spin branch runs the command after the separator, and log echoes the
  // message to stderr, where the real gum writes it. choose answers with
  // whatever the example wants picked, standing in for the keypress.
  writeStub(
    "gum",
    [
      'case "$1" in',
      "  spin)",
      "    shift",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    [ "$1" = "--" ] && shift',
      '    exec "$@"',
      "    ;;",
      "  log)",
      '    printf "%s\\n" "${@: -1}" >&2',
      "    ;;",
      "  choose)",
      "    shift",
      "    # An option gum was never offered cannot be chosen. Without this the",
      "    # stub answers with whatever the example asked for and the assertion",
      "    # holds even against a prompt that offered nothing of the kind.",
      '    if [ -n "${GUM_CHOICE:-}" ]; then',
      '      for arg in "$@"; do',
      '        [ "$arg" = "$GUM_CHOICE" ] && { printf "%s\\n" "$GUM_CHOICE"; exit 0; }',
      "      done",
      '      printf "gum choose: %s was not offered\\n" "$GUM_CHOICE" >&2',
      "      exit 1",
      "    fi",
      '    printf "\\n"',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );

  writeStub(
    "gh",
    [
      `printf '%s\\n' "$*" >>"${join(sandbox, "gh.log")}"`,
      "printf 'https://example.test/pr/1\\n'",
    ].join("\n"),
  );

  // `hostname -s` and `hostname` differ on a real machine, and the guard has to
  // cover both.
  writeStub(
    "hostname",
    ['[ "$1" = "-s" ] && { printf "spechost\\n"; exit 0; }', 'printf "spechost.example.test\\n"'].join(
      "\n",
    ),
  );

  // macOS keeps the Cocoa-facing name separately, and a user can set it to
  // something the POSIX hostname does not contain. HostName is commonly unset,
  // which scutil reports as a failure with nothing on stdout.
  writeStub(
    "scutil",
    [
      'case "$2" in',
      '  ComputerName)  printf "Spec Machine\\n" ;;',
      '  LocalHostName) printf "spechost\\n" ;;',
      "  *)             exit 1 ;;",
      "esac",
    ].join("\n"),
  );

  writeStub("osascript", `printf '%s\\n' "$2" >>"${join(sandbox, "notifications")}"`);
  writeStub("open", `printf 'todo\\n' >>"${join(sandbox, "todos")}"`);

  process.env.PATH = `${stubs}:${environment.PATH}`;
  delete process.env.GUM_CHOICE;
  gitConfigEnvironment = gitConfigKeys().map((key) => [key, process.env[key] ?? ""]);

  run(["git", "init", "-q", "--bare", "-b", "main", origin]);
  run(["git", "init", "-q", "-b", "main", repo]);
  run(["git", "-C", repo, "config", "user.email", "spec@example.test"]);
  run(["git", "-C", repo, "config", "user.name", "Spec"]);
  run(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  run(["git", "-C", repo, "remote", "add", "origin", origin]);
  writeFileSync(join(repo, "file.txt"), "tracked\n");
  run(["git", "-C", repo, "add", "-A"]);
  run(["git", "-C", repo, "commit", "-q", "-m", "initial"]);
  run(["git", "-C", repo, "push", "-q", "-u", "origin", "main"]);
  run(["git", "-C", repo, "remote", "set-head", "origin", "main"]);

  // A stub that failed to shadow the real command would reach this machine's own
  // hostname and the real gh, so every example after it would be asserting
  // against the runner. Prove the shadowing before each one.
  if (!hostNames().includes("spechost")) {
    throw new Error(`hostname resolved to ${JSON.stringify(hostNames())}`);
  }

  out = recording();
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  if (environment.GUM_CHOICE === undefined) delete process.env.GUM_CHOICE;
  else process.env.GUM_CHOICE = environment.GUM_CHOICE;
  if (environment.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = environment.XDG_STATE_HOME;
  for (const key of gitConfigKeys()) delete process.env[key];
  for (const [key, value] of gitConfigEnvironment) process.env[key] = value;
  rmSync(sandbox, { recursive: true, force: true });
});

// openPr is the one path that pushes a dirty deploy checkout to a remote, and
// both repos it serves are public. Vibe Island writes this machine's name into
// settings.json as part of a hook command, so the changes this path captures are
// exactly the ones that can carry it.
describe("openPr against changes that name this machine", () => {
  function refused(): void {
    expect(openPr(out, repo, "Title")).toBe(false);
  }

  test("refuses the short name", () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    refused();
    expect(out.captured()).toContain("refusing to push");
    expect(notifications()).toContain("name this machine");
  });

  test("refuses the fully qualified name", () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost.example.test\n");
    refused();
  });

  // Vibe Island writes the host lowercased into the hook command while the
  // machine reports it capitalized, so an exact match would miss it.
  test("refuses a name in another case", () => {
    writeFileSync(join(repo, "file.txt"), "ran on SPECHOST\n");
    refused();
  });

  // `git add -A` commits untracked files too, so a guard reading only the tracked
  // diff would wave through a file an app just dropped in.
  test("refuses an untracked file whose contents name it", () => {
    writeFileSync(join(repo, "dropped.txt"), "ran on spechost\n");
    refused();
  });

  test("refuses an untracked file whose own name names it", () => {
    writeFileSync(join(repo, "spechost-diagnostics.txt"), "unremarkable\n");
    refused();
  });

  // An app asking Cocoa for the computer's name gets this one, which the POSIX
  // hostname need not contain.
  test("refuses the Cocoa computer name", () => {
    writeFileSync(join(repo, "file.txt"), "ran on Spec Machine\n");
    refused();
  });

  test("leaves the tree and the branches untouched", () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    refused();
    expect(git("branch", "--list", "sync/*").stdout).toBe("");
    expect(ghLog()).toBe("");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("ran on spechost\n");
  });
});

// Vibe Island writes on its own schedule, so the tree can gain the machine's name
// after the first check has already passed. The git stub writes it in on the
// `add`, standing in for that timing.
test("openPr refuses a change that arrives once the tree is staged", () => {
  writeFileSync(join(repo, "file.txt"), "unremarkable\n");

  const realGit = Bun.which("git", { PATH: environment.PATH });
  if (realGit === null) throw new Error("git is not on PATH");
  writeStub(
    "git",
    [
      'for a in "$@"; do',
      `  [ "$a" = add ] && printf "ran on spechost\\n" >>"${join(repo, "file.txt")}"`,
      "done",
      `exec ${realGit} "$@"`,
    ].join("\n"),
  );

  expect(openPr(out, repo, "Title")).toBe(false);
  expect(out.captured()).toContain("refusing to push");
  expect(notifications()).toContain("name this machine");
  expect(ghLog()).toBe("");
});

describe("openPr against changes that do not name this machine", () => {
  // The machine's name is short, so an unanchored match would find it inside
  // unrelated words and refuse a sync over nothing.
  test("allows a name embedded in a longer word", () => {
    writeFileSync(join(repo, "file.txt"), "the spechostname helper and a spechosting provider\n");
    expect(openPr(out, repo, "Title")).toBe(true);
    expect(ghLog()).toContain("pr create");
  });

  test("opens the PR", () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(openPr(out, repo, "Title")).toBe(true);
    expect(ghLog()).toContain("pr create");
    expect(notifications()).toContain("Opened PR");
  });

  // The message used to carry `hostname -s`, publishing the host on every sync.
  // The branch name already dates the run.
  test("commits without naming the machine", () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(openPr(out, repo, "Title")).toBe(true);
    const subject = stripNewlines(git("log", "-1", "--format=%s", "--branches=sync/*").stdout);
    expect(subject).toBe("sync: local changes captured");
  });

  test("returns to the base branch with the change carried away", () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(openPr(out, repo, "Title")).toBe(true);
    expect(stripNewlines(git("symbolic-ref", "--short", "HEAD").stdout)).toBe("main");
    expect(stripNewlines(git("status", "--porcelain").stdout)).toBe("");
  });
});

describe("hostNames", () => {
  // A machine with neither hostname nor scutil contributes no names, and there is
  // nothing there to leak, so nothing is refused over it.
  test("finds nothing, and refuses nothing, where neither command exists", () => {
    const empty = join(sandbox, "empty");
    mkdirSync(empty);
    process.env.PATH = empty;
    try {
      expect(hostNames()).toEqual([]);
      expect(changesNameHost(repo)).toBe(false);
    } finally {
      process.env.PATH = `${stubs}:${environment.PATH}`;
    }
  });

  test("carries every form the machine answers to", () => {
    expect(hostNames()).toEqual([
      "spechost",
      "spechost.example.test",
      "Spec Machine",
      "spechost",
    ]);
  });
});

describe("capturableContent", () => {
  test("carries the tracked diff and every untracked file's name and contents", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    writeFileSync(join(repo, "dropped.txt"), "secret\n");
    const content = [...capturableContent(repo)].join("");
    expect(content).toContain("+edited");
    expect(content).toContain("dropped.txt");
    expect(content).toContain("secret");
  });

  // An untracked file can be any size. Held whole it would overrun the string
  // limit and crash a job that only had to answer yes or no, so the content
  // arrives in chunks and the guard stops at the first one that matches.
  test("chunks a file larger than one read", () => {
    writeFileSync(join(repo, "big.txt"), "a".repeat(3 << 20));
    const chunks = [...capturableContent(repo)];
    expect(chunks.length).toBeGreaterThan(3);
  });
});

describe("changesNameHost", () => {
  test("refuses an untracked file naming this machine", () => {
    writeFileSync(join(repo, "hook.txt"), "runs as spechost\n");
    expect(changesNameHost(repo)).toBe(true);
  });

  // Each chunk carries the tail of the one before it, or a name landing on the
  // boundary is two half-names neither of which matches.
  test("refuses a name straddling a chunk boundary", () => {
    const boundary = 1 << 20;
    const padding = "a".repeat(boundary - 4);
    writeFileSync(join(repo, "big.txt"), `${padding} spechost ${"a".repeat(1024)}`);
    expect(changesNameHost(repo)).toBe(true);
  });
});

describe("syncNotify", () => {
  test("reports the new rev and does not notify when the clone moved", () => {
    pushIgnoreRule("scratch/");
    const result = syncNotify(out, repo, "Title");
    expect(result).toEqual({ status: "updated", rev: stripNewlines(git("rev-parse", "--short", "HEAD").stdout) });
    expect(notifications()).toBe("");
  });

  test("reports current with no rev and does not notify", () => {
    expect(syncNotify(out, repo, "Title")).toEqual({ status: "current" });
    expect(notifications()).toBe("");
  });

  test("reports failed and notifies", () => {
    const missing = join(sandbox, "not-a-repo");
    mkdirSync(missing);
    expect(syncNotify(out, missing, "Title")).toEqual({ status: "failed" });
    expect(notifications()).toContain("Failed: could not sync");
  });
});

describe("renderDiff", () => {
  // `git diff HEAD` names no untracked file, so the report of a block over one
  // used to carry an empty diff.
  test("renders an untracked file as a new-file diff", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    const rendered = renderDiff(repo);
    expect(rendered).toContain("+++ b/stray.txt");
    expect(rendered).toContain("+stray");
  });

  test("renders a tracked modification", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    expect(renderDiff(repo)).toContain("+edited");
  });

  // An app that rewrote a settings file without changing anything in it is noise
  // in a report someone reads at 3am.
  test("renders nothing for a JSON file whose keys only moved", () => {
    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":2}\n');
    run(["git", "-C", repo, "add", "-A"]);
    run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);

    writeFileSync(join(repo, "settings.json"), '{\n  "b": 2,\n  "a": 1\n}\n');
    expect(renderDiff(repo)).toBe("");
  });

  test("renders a JSON file whose values changed", () => {
    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":2}\n');
    run(["git", "-C", repo, "add", "-A"]);
    run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);

    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":3}\n');
    const rendered = renderDiff(repo);
    expect(rendered).toContain("a/settings.json");
    expect(rendered).toContain('+  "b": 3');
  });

  // A path the gate lists as blocking with no evidence attached is a report with
  // nothing in it to act on.
  test("renders a deleted tracked file", () => {
    rmSync(join(repo, "file.txt"));
    expect(renderDiff(repo)).toContain("-tracked");
  });
});

describe("reviewBlocking", () => {
  // The rule and the files it covers ship in the same commit, so the rule can
  // only reach this checkout through the pull the gate is blocking.
  test("clears an untracked path the incoming .gitignore covers", () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(reviewBlocking(repo, "main")).toEqual([]);
  });

  // .gitignore says nothing about a path git already tracks, so nothing the pull
  // carries may wave one through.
  test("keeps a tracked modification blocking", () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    writeFileSync(join(repo, "file.txt"), "edited\n");

    expect(reviewBlocking(repo, "main")).toEqual(["file.txt"]);
  });

  test("keeps an untracked path neither .gitignore covers blocking", () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    writeFileSync(join(repo, "stray.txt"), "stray\n");

    expect(reviewBlocking(repo, "main")).toEqual(["stray.txt"]);
  });

  // With no branch to read, only the rules already on disk have a say.
  test("judges against the local rules when given no branch", () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(reviewBlocking(repo)).toEqual([join("scratch", "note.txt")]);
  });

  // The exclude file is written into the git dir, and a run that left it behind
  // would hand the next one rules it never fetched.
  // Inside $GIT_DIR, where no status listing reaches it. A leftover accumulates
  // one file per run of a job that runs every night.
  test("leaves no exclude file behind", () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    reviewBlocking(repo, "main");

    const gitDir = stripNewlines(git("rev-parse", "--absolute-git-dir").stdout);
    const leftovers = readdirSync(gitDir).filter((name) => name.startsWith("incoming-exclude"));
    expect(leftovers).toEqual([]);
  });
});

describe("reviewDirty", () => {
  test("passes a clean tree straight through", () => {
    expect(reviewDirty(out, repo, "Title")).toBe(true);
    expect(notifications()).toBe("");
  });

  test("syncs past an untracked path the incoming .gitignore covers", () => {
    pushIgnoreRule("scratch/");
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(reviewDirty(out, repo, "Title")).toBe(true);
    expect(out.captured()).toContain("ignored by the incoming .gitignore");
  });

  test("skips and notifies when nothing is watching", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");

    expect(reviewDirty(out, repo, "Title", { interactive: () => false })).toBe(false);
    expect(out.captured()).toContain("Local changes present - skipping sync");
    expect(notifications()).toContain("Skipped: local changes present");
  });

  // bin/claude-upgrade fingerprints on fields 2-4 of the WARN and ERRO lines, and
  // "Local changes present - skipping sync" reads the same whatever is dirty. The
  // paths need a line of their own, or a block recurring over a different dirty
  // set files no to-do after the first and the deadlock goes silent.
  test("gives the blocking paths a log line of their own", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    reviewDirty(out, repo, "Title", { interactive: () => false });
    expect(out.captured()).toContain("\nstray.txt \n");
  });

  test("renders the tree and the diff before it decides", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    reviewDirty(out, repo, "Title", { interactive: () => false });

    const captured = out.captured();
    expect(captured).toContain("?? stray.txt");
    expect(captured).toContain("+++ b/stray.txt");
  });

  // The jobs latch their to-do on the log's warnings, so a tree that stays dirty
  // in the same way files once and then holds the sync shut in silence. From the
  // second unattended skip on, the count in a row goes into the log at the power
  // of two below it, so the fingerprint moves on a lengthening cadence.
  test("escalates on a lengthening cadence while the skips continue", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    const skip = (): string => {
      out = recording();
      reviewDirty(out, repo, "Title", { interactive: () => false });
      return out.captured().match(/Sync skipped (\d+) runs in a row/)?.[1] ?? "";
    };

    expect(Array.from({ length: 8 }, skip)).toEqual(["", "2", "2", "4", "4", "4", "4", "8"]);
  });

  test("forgets the skips once the gate lets a sync through", () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    reviewDirty(out, repo, "Title", { interactive: () => false });
    reviewDirty(out, repo, "Title", { interactive: () => false });

    rmSync(join(repo, "stray.txt"));
    expect(reviewDirty(out, repo, "Title")).toBe(true);

    writeFileSync(join(repo, "stray.txt"), "stray\n");
    out = recording();
    reviewDirty(out, repo, "Title", { interactive: () => false });
    expect(out.captured()).not.toContain("runs in a row");
  });

  // The count only paces the notifications, so a state directory it cannot
  // write must not preempt the skip the gate exists to perform. A file standing
  // where the directory goes is the cheapest way to make every write fail.
  test("skips and syncs as usual when the count cannot be stored", () => {
    const blocked = join(sandbox, "blocked-state");
    writeFileSync(blocked, "");
    process.env.XDG_STATE_HOME = blocked;

    writeFileSync(join(repo, "stray.txt"), "stray\n");
    expect(reviewDirty(out, repo, "Title", { interactive: () => false })).toBe(false);
    expect(out.captured()).toContain("Local changes present - skipping sync");

    rmSync(join(repo, "stray.txt"));
    expect(reviewDirty(out, repo, "Title")).toBe(true);
  });

  // Someone was watching, so the skip needs no escalation to reach them.
  test("leaves a skip chosen at the prompt uncounted", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = SKIP;
    reviewDirty(out, repo, "Title", { interactive: () => true });

    out = recording();
    reviewDirty(out, repo, "Title", { interactive: () => true });
    expect(out.captured()).not.toContain("runs in a row");
  });

  test("discards the changes and continues when asked to", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    process.env.GUM_CHOICE = DISCARD;

    expect(reviewDirty(out, repo, "Title", { interactive: () => true })).toBe(true);
    expect(stripNewlines(git("status", "--porcelain").stdout)).toBe("");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("tracked\n");
  });

  test("opens a PR and continues when asked to", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = OPEN_PR;

    expect(reviewDirty(out, repo, "Title", { interactive: () => true })).toBe(true);
    expect(ghLog()).toContain("pr create");
  });

  test("skips when asked to", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = SKIP;

    expect(reviewDirty(out, repo, "Title", { interactive: () => true })).toBe(false);
    expect(notifications()).toContain("Skipped: local changes present");
  });

  // A prompt that could not be answered is not consent to throw the tree away.
  test("skips when the prompt answers with nothing", () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = "";

    expect(reviewDirty(out, repo, "Title", { interactive: () => true })).toBe(false);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("edited\n");
  });

  // The refusal is the whole sync's answer, so the tree is left for inspection
  // rather than discarded or carried out on a branch.
  test("refuses a PR whose changes name this machine and leaves the tree alone", () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    process.env.GUM_CHOICE = OPEN_PR;

    expect(reviewDirty(out, repo, "Title", { interactive: () => true })).toBe(false);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("ran on spechost\n");
    expect(ghLog()).toBe("");
  });
});

describe("defaultBranch", () => {
  test("reads the branch origin/HEAD points at", () => {
    expect(defaultBranch(repo)).toBe("main");
  });

  // A directory that is not a repo answers nothing, and main is the fallback
  // every caller here is written against.
  test("falls back to main", () => {
    const missing = join(sandbox, "not-a-repo");
    mkdirSync(missing);
    expect(defaultBranch(missing)).toBe("main");
  });
});

describe("httpsEnv", () => {
  // Claude Code clones marketplaces from git@github.com: and re-clones them on
  // every update, so the rewrite has to reach those children. It outranks a
  // pushurl, which is why it travels as an environment rather than being taken on
  // process-wide.
  test("carries the insteadOf rewrite as git config environment entries", () => {
    delete process.env.GIT_CONFIG_COUNT;
    const env = httpsEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_0).toBe("git@github.com:");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_1).toBe("ssh://git@github.com/");
  });

  // A machine-local entry already in the environment is what a child inherits
  // besides this rewrite, and replacing the count would silently drop it.
  test("appends to a count already in the environment", () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = "cat";

    const env = httpsEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_1).toBe("git@github.com:");
  });
});

describe("stripNewlines and lines", () => {
  test("strip what command substitution stripped", () => {
    expect(stripNewlines("abc1234\n\n")).toBe("abc1234");
    expect(stripNewlines("")).toBe("");
  });

  test("drop the empty trailing line a newline-terminated list ends with", () => {
    expect(lines("a\nb\n")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([]);
  });
});
