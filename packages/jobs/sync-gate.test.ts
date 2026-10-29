import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
  renderDiff,
  reviewBlocking,
  stripNewlines,
} from "#jobs/sync-gate";
import { writeStub } from "#harness";
import { call } from "#harness/call";
import { fixture } from "#harness/fixture";
import { landCommit } from "#harness/git";

let sandbox: string;
let stubs: string;
let repo: string;
let origin: string;
// What the last gateCall wrote, both streams in the order they arrived.
let output = "";

// Every branch under test is a sequence of real git commands, so the children run
// for real. A gate step that logs runs in a child, which is how an example reads
// the log the job produced.
async function gateCall<T>(name: string, ...args: unknown[]): Promise<T> {
  const called = await call<T>(join(import.meta.dir, "sync-gate.ts"), name, args);
  output = called.output;
  return called.value;
}

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

function stub(name: string, body: string): void {
  writeStub(join(stubs, name), body);
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
  landCommit(origin, { ".gitignore": `${rule}\n` }, `ignore ${rule}`);
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync({ cmd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
}

function buildRepo(root: string): void {
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
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
}

const copyRepo = fixture(buildRepo);

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "sync-gate-"));
  stubs = join(sandbox, "stub");
  repo = join(sandbox, "repo");
  origin = join(sandbox, "origin.git");
  mkdirSync(stubs);
  process.env.XDG_STATE_HOME = join(sandbox, "state");

  // choose answers with whatever the example wants picked, standing in for the
  // keypress. log echoes the message to stderr, where the real gum writes it,
  // and spin runs the command after the separator.
  stub(
    "gum",
    [
      'case "$1" in',
      "  choose)",
      "    # An option gum was never offered cannot be chosen. Without this the",
      "    # stub answers with whatever the example asked for and the assertion",
      "    # holds even against a prompt that offered nothing of the kind.",
      '    offered=$(cat)',
      '    if [ -n "${GUM_CHOICE:-}" ]; then',
      '      printf "%s\\n" "$offered" | grep -qxF -- "$GUM_CHOICE" && { printf "%s\\n" "$GUM_CHOICE"; exit 0; }',
      '      printf "gum choose: %s was not offered\\n" "$GUM_CHOICE" >&2',
      "      exit 1",
      "    fi",
      '    printf "\\n"',
      "    ;;",
      "  log)",
      "    for last; do :; done",
      '    printf "%s\\n" "$last" >&2',
      "    ;;",
      "  spin)",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    [ "$1" = "--" ] && shift',
      '    exec "$@"',
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );

  stub(
    "gh",
    [
      `printf '%s\\n' "$*" >>"${join(sandbox, "gh.log")}"`,
      "printf 'https://example.test/pr/1\\n'",
    ].join("\n"),
  );

  // `hostname -s` and `hostname` differ on a real machine, and the guard has to
  // cover both.
  stub(
    "hostname",
    ['[ "$1" = "-s" ] && { printf "spechost\\n"; exit 0; }', 'printf "spechost.example.test\\n"'].join(
      "\n",
    ),
  );

  // macOS keeps the Cocoa-facing name separately, and a user can set it to
  // something the POSIX hostname does not contain. HostName is commonly unset,
  // which scutil reports as a failure with nothing on stdout.
  stub(
    "scutil",
    [
      'case "$2" in',
      '  ComputerName)  printf "Spec Machine\\n" ;;',
      '  LocalHostName) printf "spechost\\n" ;;',
      "  *)             exit 1 ;;",
      "esac",
    ].join("\n"),
  );

  stub("osascript", `printf '%s\\n' "$2" >>"${join(sandbox, "notifications")}"`);
  stub("open", `printf 'todo\\n' >>"${join(sandbox, "todos")}"`);

  process.env.PATH = `${stubs}:${environment.PATH}`;
  delete process.env.GUM_CHOICE;
  gitConfigEnvironment = gitConfigKeys().map((key) => [key, process.env[key] ?? ""]);

  copyRepo(sandbox);

  // A stub that failed to shadow the real command would reach this machine's own
  // hostname and the real gh, so every example after it would be asserting
  // against the runner. Prove the shadowing before each one.
  const names = await hostNames();
  if (!names.includes("spechost")) {
    throw new Error(`hostname resolved to ${JSON.stringify(names)}`);
  }
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
// both repos it serves are public. An app that writes into settings.json can
// put this machine's name there, so the changes this path captures are exactly
// the ones that can carry it.
describe("openPr against changes that name this machine", () => {
  async function refused(): Promise<void> {
    expect(await gateCall("openPr", repo, "Title")).toBe(false);
  }

  test("refuses the short name", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    await refused();
    expect(output).toContain("refusing to push");
    expect(notifications()).toContain("name this machine");
  });

  test("refuses the fully qualified name", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost.example.test\n");
    await refused();
  });

  // An app may write the host lowercased while the machine reports it
  // capitalized, so an exact match would miss it.
  test("refuses a name in another case", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on SPECHOST\n");
    await refused();
  });

  // `git add -A` commits untracked files too, so a guard reading only the tracked
  // diff would wave through a file an app just dropped in.
  test("refuses an untracked file whose contents name it", async () => {
    writeFileSync(join(repo, "dropped.txt"), "ran on spechost\n");
    await refused();
  });

  test("refuses an untracked file whose own name names it", async () => {
    writeFileSync(join(repo, "spechost-diagnostics.txt"), "unremarkable\n");
    await refused();
  });

  // An app asking Cocoa for the computer's name gets this one, which the POSIX
  // hostname need not contain.
  test("refuses the Cocoa computer name", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on Spec Machine\n");
    await refused();
  });

  test("leaves the tree and the branches untouched", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    await refused();
    expect(git("branch", "--list", "sync/*").stdout).toBe("");
    expect(ghLog()).toBe("");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("ran on spechost\n");
  });
});

// An app writes on its own schedule, so the tree can gain the machine's name
// after the first check has already passed. The git stub writes it in on the
// `add`, standing in for that timing.
test("openPr refuses a change that arrives once the tree is staged", async () => {
  writeFileSync(join(repo, "file.txt"), "unremarkable\n");

  const realGit = Bun.which("git", { PATH: environment.PATH });
  if (realGit === null) throw new Error("git is not on PATH");
  stub(
    "git",
    [
      'for a in "$@"; do',
      `  [ "$a" = add ] && printf "ran on spechost\\n" >>"${join(repo, "file.txt")}"`,
      "done",
      `exec ${realGit} "$@"`,
    ].join("\n"),
  );

  expect(await gateCall("openPr", repo, "Title")).toBe(false);
  expect(output).toContain("refusing to push");
  expect(notifications()).toContain("name this machine");
  expect(ghLog()).toBe("");
});

describe("openPr against changes that do not name this machine", () => {
  // The machine's name is short, so an unanchored match would find it inside
  // unrelated words and refuse a sync over nothing.
  test("allows a name embedded in a longer word", async () => {
    writeFileSync(join(repo, "file.txt"), "the spechostname helper and a spechosting provider\n");
    expect(await gateCall("openPr", repo, "Title")).toBe(true);
    expect(ghLog()).toContain("pr create");
  });

  test("opens the PR", async () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(await gateCall("openPr", repo, "Title")).toBe(true);
    expect(ghLog()).toContain("pr create");
    expect(notifications()).toContain("Opened PR");
  });

  // The message used to carry `hostname -s`, publishing the host on every sync.
  // The branch name already dates the run.
  test("commits without naming the machine", async () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(await gateCall("openPr", repo, "Title")).toBe(true);
    const subject = stripNewlines(git("log", "-1", "--format=%s", "--branches=sync/*").stdout);
    expect(subject).toBe("sync: local changes captured");
  });

  // Secretive refuses to sign while the Mac is locked, which is when this runs.
  test("commits unsigned where signing is on", async () => {
    run(["git", "-C", repo, "config", "commit.gpgsign", "true"]);
    run(["git", "-C", repo, "config", "gpg.program", "false"]);
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(await gateCall("openPr", repo, "Title")).toBe(true);
    expect(stripNewlines(git("log", "-1", "--format=%G?", "--branches=sync/*").stdout)).toBe("N");
  });

  test("returns to the base branch with the change carried away", async () => {
    writeFileSync(join(repo, "file.txt"), "unremarkable\n");
    expect(await gateCall("openPr", repo, "Title")).toBe(true);
    expect(stripNewlines(git("symbolic-ref", "--short", "HEAD").stdout)).toBe("main");
    expect(stripNewlines(git("status", "--porcelain").stdout)).toBe("");
  });
});

describe("hostNames", () => {
  // A machine with neither hostname nor scutil contributes no names, and there is
  // nothing there to leak, so nothing is refused over it.
  test("finds nothing, and refuses nothing, where neither command exists", async () => {
    const empty = join(sandbox, "empty");
    mkdirSync(empty);
    process.env.PATH = empty;
    try {
      expect(await hostNames()).toEqual([]);
      expect(await changesNameHost(repo)).toBe(false);
    } finally {
      process.env.PATH = `${stubs}:${environment.PATH}`;
    }
  });

  test("carries every form the machine answers to", async () => {
    expect(await hostNames()).toEqual([
      "spechost",
      "spechost.example.test",
      "Spec Machine",
      "spechost",
    ]);
  });
});

describe("capturableContent", () => {
  test("carries the tracked diff and every untracked file's name and contents", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    writeFileSync(join(repo, "dropped.txt"), "secret\n");
    const content = (await Array.fromAsync(capturableContent(repo))).join("");
    expect(content).toContain("+edited");
    expect(content).toContain("dropped.txt");
    expect(content).toContain("secret");
  });

  // An untracked file can be any size. Held whole it would overrun the string
  // limit and crash a job that only had to answer yes or no, so the content
  // arrives in chunks and the guard stops at the first one that matches.
  test("chunks a file larger than one read", async () => {
    writeFileSync(join(repo, "big.txt"), "a".repeat(3 << 20));
    const chunks = await Array.fromAsync(capturableContent(repo));
    expect(chunks.length).toBeGreaterThan(3);
  });
});

describe("changesNameHost", () => {
  test("refuses an untracked file naming this machine", async () => {
    writeFileSync(join(repo, "hook.txt"), "runs as spechost\n");
    expect(await changesNameHost(repo)).toBe(true);
  });

  // Each chunk carries the tail of the one before it, or a name landing on the
  // boundary is two half-names neither of which matches.
  test("refuses a name straddling a chunk boundary", async () => {
    const boundary = 1 << 20;
    const padding = "a".repeat(boundary - 4);
    writeFileSync(join(repo, "big.txt"), `${padding} spechost ${"a".repeat(1024)}`);
    expect(await changesNameHost(repo)).toBe(true);
  });
});

describe("syncNotify", () => {
  test("reports the new rev and does not notify when the clone moved", async () => {
    pushIgnoreRule("scratch/");
    const result = await gateCall("syncNotify", repo, "Title");
    expect(result).toEqual({ status: "updated", rev: stripNewlines(git("rev-parse", "--short", "HEAD").stdout) });
    expect(notifications()).toBe("");
  });

  test("reports current with no rev and does not notify", async () => {
    expect(await gateCall("syncNotify", repo, "Title")).toEqual({ status: "current" });
    expect(notifications()).toBe("");
  });

  test("reports failed and notifies", async () => {
    const missing = join(sandbox, "not-a-repo");
    mkdirSync(missing);
    expect(await gateCall("syncNotify", missing, "Title")).toEqual({ status: "failed" });
    expect(notifications()).toContain("Failed: could not sync");
  });
});

describe("renderDiff", () => {
  // `git diff HEAD` names no untracked file, so the report of a block over one
  // used to carry an empty diff.
  test("renders an untracked file as a new-file diff", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    const rendered = await renderDiff(repo);
    expect(rendered).toContain("+++ b/stray.txt");
    expect(rendered).toContain("+stray");
  });

  test("renders a tracked modification", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    expect(await renderDiff(repo)).toContain("+edited");
  });

  // An app that rewrote a settings file without changing anything in it is noise
  // in a report someone reads at 3am.
  test("renders nothing for a JSON file whose keys only moved", async () => {
    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":2}\n');
    run(["git", "-C", repo, "add", "-A"]);
    run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);

    writeFileSync(join(repo, "settings.json"), '{\n  "b": 2,\n  "a": 1\n}\n');
    expect(await renderDiff(repo)).toBe("");
  });

  test("renders a JSON file whose values changed", async () => {
    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":2}\n');
    run(["git", "-C", repo, "add", "-A"]);
    run(["git", "-C", repo, "commit", "-q", "-m", "settings"]);

    writeFileSync(join(repo, "settings.json"), '{"a":1,"b":3}\n');
    const rendered = await renderDiff(repo);
    expect(rendered).toContain("a/settings.json");
    expect(rendered).toContain('+  "b": 3');
  });

  // A path the gate lists as blocking with no evidence attached is a report with
  // nothing in it to act on.
  test("renders a deleted tracked file", async () => {
    rmSync(join(repo, "file.txt"));
    expect(await renderDiff(repo)).toContain("-tracked");
  });
});

describe("reviewBlocking", () => {
  // The rule and the files it covers ship in the same commit, so the rule can
  // only reach this checkout through the pull the gate is blocking.
  test("clears an untracked path the incoming .gitignore covers", async () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(await reviewBlocking(repo, "main")).toEqual([]);
  });

  // .gitignore says nothing about a path git already tracks, so nothing the pull
  // carries may wave one through.
  test("keeps a tracked modification blocking", async () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    writeFileSync(join(repo, "file.txt"), "edited\n");

    expect(await reviewBlocking(repo, "main")).toEqual(["file.txt"]);
  });

  test("keeps an untracked path neither .gitignore covers blocking", async () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    writeFileSync(join(repo, "stray.txt"), "stray\n");

    expect(await reviewBlocking(repo, "main")).toEqual(["stray.txt"]);
  });

  // With no branch to read, only the rules already on disk have a say.
  test("judges against the local rules when given no branch", async () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(await reviewBlocking(repo)).toEqual([join("scratch", "note.txt")]);
  });

  // The exclude file is written into the git dir, and a run that left it behind
  // would hand the next one rules it never fetched.
  // Inside $GIT_DIR, where no status listing reaches it. A leftover accumulates
  // one file per run of a job that runs every night.
  test("leaves no exclude file behind", async () => {
    pushIgnoreRule("scratch/");
    run(["git", "-C", repo, "fetch", "-q", "origin", "main"]);
    await reviewBlocking(repo, "main");

    const gitDir = stripNewlines(git("rev-parse", "--absolute-git-dir").stdout);
    const leftovers = readdirSync(gitDir).filter((name) => name.startsWith("incoming-exclude"));
    expect(leftovers).toEqual([]);
  });
});

describe("reviewDirty", () => {
  test("passes a clean tree straight through", async () => {
    expect(await gateCall("reviewDirty", repo, "Title")).toBe(true);
    expect(notifications()).toBe("");
  });

  test("syncs past an untracked path the incoming .gitignore covers", async () => {
    pushIgnoreRule("scratch/");
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "note.txt"), "note\n");

    expect(await gateCall("reviewDirty", repo, "Title")).toBe(true);
    expect(output).toContain("ignored by the incoming .gitignore");
  });

  test("skips and notifies when nothing is watching", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: false })).toBe(false);
    expect(output).toContain("Local changes present - skipping sync");
    expect(notifications()).toContain("Skipped: local changes present");
  });

  // bin/claude-sync fingerprints on fields 2-4 of the WARN and ERRO lines, and
  // "Local changes present - skipping sync" reads the same whatever is dirty. The
  // paths need a line of their own, or a block recurring over a different dirty
  // set files no to-do after the first and the deadlock goes silent.
  test("gives the blocking paths a log line of their own", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    await gateCall("reviewDirty", repo, "Title", { interactive: false });
    expect(output).toContain("\nstray.txt \n");
  });

  test("renders the tree and the diff before it decides", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    await gateCall("reviewDirty", repo, "Title", { interactive: false });

    const captured = output;
    expect(captured).toContain("?? stray.txt");
    expect(captured).toContain("+++ b/stray.txt");
  });

  // The jobs latch their to-do on the log's warnings, so a tree that stays dirty
  // in the same way files once and then holds the sync shut in silence. From the
  // second unattended skip on, the count in a row goes into the log at the power
  // of two below it, so the fingerprint moves on a lengthening cadence.
  test("escalates on a lengthening cadence while the skips continue", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    const skips: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      await gateCall("reviewDirty", repo, "Title", { interactive: false });
      skips.push(output.match(/Sync skipped (\d+) runs in a row/)?.[1] ?? "");
    }

    expect(skips).toEqual(["", "2", "2", "4", "4", "4", "4", "8"]);
    // Eight real gate passes, a dozen git and shell children each, is several
    // times any other case here and crosses the default under a loaded machine.
  }, 15_000);

  test("forgets the skips once the gate lets a sync through", async () => {
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    await gateCall("reviewDirty", repo, "Title", { interactive: false });
    await gateCall("reviewDirty", repo, "Title", { interactive: false });

    rmSync(join(repo, "stray.txt"));
    expect(await gateCall("reviewDirty", repo, "Title")).toBe(true);

    writeFileSync(join(repo, "stray.txt"), "stray\n");
    await gateCall("reviewDirty", repo, "Title", { interactive: false });
    expect(output).not.toContain("runs in a row");
  });

  // The count only paces the notifications, so a state directory it cannot
  // write must not preempt the skip the gate exists to perform. A file standing
  // where the directory goes is the cheapest way to make every write fail.
  test("skips and syncs as usual when the count cannot be stored", async () => {
    const blocked = join(sandbox, "blocked-state");
    writeFileSync(blocked, "");
    process.env.XDG_STATE_HOME = blocked;

    writeFileSync(join(repo, "stray.txt"), "stray\n");
    expect(await gateCall("reviewDirty", repo, "Title", { interactive: false })).toBe(false);
    expect(output).toContain("Local changes present - skipping sync");

    rmSync(join(repo, "stray.txt"));
    expect(await gateCall("reviewDirty", repo, "Title")).toBe(true);
  });

  // Someone was watching, so the skip needs no escalation to reach them.
  test("leaves a skip chosen at the prompt uncounted", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = SKIP;
    await gateCall("reviewDirty", repo, "Title", { interactive: true });

    await gateCall("reviewDirty", repo, "Title", { interactive: true });
    expect(output).not.toContain("runs in a row");
  });

  test("discards the changes and continues when asked to", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    writeFileSync(join(repo, "stray.txt"), "stray\n");
    process.env.GUM_CHOICE = DISCARD;

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: true })).toBe(true);
    expect(stripNewlines(git("status", "--porcelain").stdout)).toBe("");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("tracked\n");
  });

  test("opens a PR and continues when asked to", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = OPEN_PR;

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: true })).toBe(true);
    expect(ghLog()).toContain("pr create");
  });

  test("skips when asked to", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = SKIP;

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: true })).toBe(false);
    expect(notifications()).toContain("Skipped: local changes present");
  });

  // A prompt that could not be answered is not consent to throw the tree away.
  test("skips when the prompt answers with nothing", async () => {
    writeFileSync(join(repo, "file.txt"), "edited\n");
    process.env.GUM_CHOICE = "";

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: true })).toBe(false);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("edited\n");
  });

  // The refusal is the whole sync's answer, so the tree is left for inspection
  // rather than discarded or carried out on a branch.
  test("refuses a PR whose changes name this machine and leaves the tree alone", async () => {
    writeFileSync(join(repo, "file.txt"), "ran on spechost\n");
    process.env.GUM_CHOICE = OPEN_PR;

    expect(await gateCall("reviewDirty", repo, "Title", { interactive: true })).toBe(false);
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("ran on spechost\n");
    expect(ghLog()).toBe("");
  });
});

describe("defaultBranch", () => {
  test("reads the branch origin/HEAD points at", async () => {
    expect(await defaultBranch(repo)).toBe("main");
  });

  // A directory that is not a repo answers nothing, and main is the fallback
  // every caller here is written against.
  test("falls back to main", async () => {
    const missing = join(sandbox, "not-a-repo");
    mkdirSync(missing);
    expect(await defaultBranch(missing)).toBe("main");
  });
});

describe("httpsEnv", () => {
  // Claude Code clones marketplaces from git@github.com: and re-clones them on
  // every update, so the rewrite has to reach those children. It outranks a
  // pushurl, which is why it travels as an environment rather than being taken on
  // process-wide.
  test("carries the insteadOf rewrite as git config environment entries", async () => {
    delete process.env.GIT_CONFIG_COUNT;
    const env = await httpsEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_0).toBe("git@github.com:");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_1).toBe("ssh://git@github.com/");
  });

  // A machine-local entry already in the environment is what a child inherits
  // besides this rewrite, and replacing the count would silently drop it.
  test("appends to a count already in the environment", async () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = "cat";

    const env = await httpsEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.https://github.com/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_1).toBe("git@github.com:");
  });
});

describe("stripNewlines and lines", () => {
  test("strip what command substitution stripped", async () => {
    expect(stripNewlines("abc1234\n\n")).toBe("abc1234");
    expect(stripNewlines("")).toBe("");
  });

  test("drop the empty trailing line a newline-terminated list ends with", async () => {
    expect(lines("a\nb\n")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([]);
  });
});
