import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditRows,
  capturedLog,
  driftFingerprint,
  driftTitle,
  type Finding,
  findingsTable,
  investigation,
  main,
  parseFinding,
  repoPath,
} from "./worktree-prune";

const SCRIPT = join(import.meta.dir, "worktree-prune");
const ESC = "\u001b";

function finding(repo: string, branch: string, reason: string, path: string): Finding {
  return { repo, branch, reason, path };
}

describe("capturedLog", () => {
  // The to-do is plain text, so `wt`'s colour would ride into it as raw escapes.
  test("strips colour from the tail it keeps", () => {
    const coloured = Array.from({ length: 3 }, (_, index) => `${ESC}[32mline ${index}${ESC}[0m`);
    expect(capturedLog(coloured.join("\n"))).toBe("line 0\nline 1\nline 2");
  });

  // A log ending in blank lines would otherwise leave the notes' next heading
  // several lines down.
  test("drops the trailing blank lines", () => {
    expect(capturedLog("a\nb\n\n\n")).toBe("a\nb");
  });
});

describe("parseFinding", () => {
  test.each<{ name: string; line: string; expected: Finding | undefined }>([
    {
      name: "reads repo, branch, reason and path",
      line: "bendrucker/dotfiles\tfeature\tintegrated (empty)\t/Users/ben/wt/feature",
      expected: finding(
        "bendrucker/dotfiles",
        "feature",
        "integrated (empty)",
        "/Users/ben/wt/feature",
      ),
    },
    // A worktree path admits a tab, and the fields end at the path, so
    // everything past the third one belongs to it.
    {
      name: "keeps a path holding a tab whole",
      line: "repo\tbranch\tmerged PR survived\t/a\tb",
      expected: finding("repo", "branch", "merged PR survived", "/a\tb"),
    },
    // Anything a repo printed that `wt all` keyed with its name but that is not
    // a finding row lands here, which is the only validation there is.
    {
      name: "rejects a line carrying no branch",
      line: "some free-form line",
      expected: undefined,
    },
    {
      name: "rejects a row whose branch field is empty",
      line: "repo\t\treason\t/path",
      expected: undefined,
    },
    {
      name: "reads a row with no path as one with an empty path",
      line: "repo\tbranch\treason",
      expected: finding("repo", "branch", "reason", ""),
    },
  ])("$name", ({ line, expected }) => {
    expect(parseFinding(line)).toEqual(expected);
  });
});

describe("auditRows", () => {
  test("drops blank and whitespace-only lines and the colour around them", () => {
    expect(auditRows(`repo\tbranch\treason\t/p\n\n   \n${ESC}[2mrepo2\tb2\tr2\t/q${ESC}[0m\n`)).toEqual(
      ["repo\tbranch\treason\t/p", "repo2\tb2\tr2\t/q"],
    );
  });

  test("reads output that is only blank lines as no rows", () => {
    expect(auditRows("\n\n")).toEqual([]);
  });
});

describe("findingsTable", () => {
  // The path is deliberately absent: it belongs to the investigation commands,
  // not to the table someone reads.
  test("aligns repo, branch and reason and leaves the path out", () => {
    const table = findingsTable([
      finding("bendrucker/dotfiles", "short", "integrated (empty)", "/a"),
      finding("x/y", "a-much-longer-branch", "merged PR survived", "/b"),
    ]);
    expect(table).toBe(
      "bendrucker/dotfiles  short                 integrated (empty)\n" +
        "x/y                  a-much-longer-branch  merged PR survived",
    );
  });

  test("leaves no trailing whitespace behind an empty reason", () => {
    expect(findingsTable([finding("repo", "branch", "", "/a")])).toBe("repo  branch");
  });
});

describe("investigation", () => {
  const leak = finding("bendrucker/dotfiles", "feature", "integrated (empty)", "/wt/feature");

  test("opens the worktree and re-runs both passes from its repo", () => {
    expect(investigation([leak], "/Users/ben/src", "1d")).toBe(
      `## bendrucker/dotfiles: feature (integrated (empty))
cd '/wt/feature' && wt list && git log --oneline -5 && git status -sb

cd '/Users/ben/src/bendrucker/dotfiles'
# Does the integration pass still see it?
wt step prune --dry-run --min-age '1d'
# What did wt-prune decide for it, and why?
wt prune --dry-run --before
# What does the forge say?
gh pr view 'feature' --json state,number,url
# Does the oracle still flag it?
wt prune-audit`,
    );
  });

  test("separates consecutive findings by one blank line", () => {
    const blocks = investigation(
      [leak, finding("other", "second", "merged PR survived", "/wt/second")],
      "/src",
      "1d",
    );
    expect(blocks).toContain("wt prune-audit\n\n## other: second");
    expect(blocks.endsWith("wt prune-audit")).toBe(true);
  });

  // A branch name admits a single quote, and these commands are pasted into a
  // shell as they stand.
  test("escapes a quote in a branch name", () => {
    const blocks = investigation([finding("r", "it's", "reason", "/wt/it's")], "/src", "1d");
    expect(blocks).toContain(`gh pr view 'it'\\''s' --json state,number,url`);
    expect(blocks).toContain(`cd '/wt/it'\\''s' && wt list`);
  });
});

describe("repoPath", () => {
  test("rebuilds a relative repo under the discovery root", () => {
    expect(repoPath("bendrucker/dotfiles", "/Users/ben/src")).toBe(
      "/Users/ben/src/bendrucker/dotfiles",
    );
  });

  // `wt all` leaves a repo discovered outside $PROJECTS absolute.
  test("passes an absolute repo through", () => {
    expect(repoPath("/opt/other/repo", "/Users/ben/src")).toBe("/opt/other/repo");
  });
});

describe("driftTitle", () => {
  test.each([
    [1, "Worktree prune leaked 1 worktree"],
    [2, "Worktree prune leaked 2 worktrees"],
  ])("names %i leaked", (leaked, expected) => {
    expect(driftTitle(leaked)).toBe(expected);
  });
});

describe("driftFingerprint", () => {
  // The fleet scan runs its repos in parallel, so the same leak set can arrive
  // in either order and must key the latch the same way.
  test("keys on the leaked set rather than its order", () => {
    const one = finding("a", "one", "integrated (empty)", "/a");
    const two = finding("b", "two", "merged PR survived", "/b");
    expect(driftFingerprint([one, two])).toBe(driftFingerprint([two, one]));
  });

  test("changes when another worktree leaks", () => {
    const one = finding("a", "one", "integrated (empty)", "/a");
    const two = finding("b", "two", "merged PR survived", "/b");
    expect(driftFingerprint([one])).not.toBe(driftFingerprint([one, two]));
  });
});

const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOTFILES_HOME: process.env.DOTFILES_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  PROJECTS: process.env.PROJECTS,
  WT_PRUNE_MIN_AGE: process.env.WT_PRUNE_MIN_AGE,
  THINGS_DATABASE: process.env.THINGS_DATABASE,
};

let sandbox: string;
let stubs: string;
let dotfiles: string;
let state: string;
let callsFile: string;
let todosFile: string;
let gumFile: string;

interface Pass {
  stdout?: string;
  stderr?: string;
  status?: number;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function passBody(pass: Pass): string {
  const lines: string[] = [];
  if (pass.stdout) lines.push(`printf '%s' ${shQuote(pass.stdout)}`);
  if (pass.stderr) lines.push(`printf '%s' ${shQuote(pass.stderr)} >&2`);
  lines.push(`exit ${pass.status ?? 0}`);
  return lines.join("\n");
}

// One stub answers both passes, because one run makes both calls. It records
// what it was called as and what WT_ALL_RAW held, which is how an example tells
// the raw audit apart from the prune.
function stubWtAll(passes: { prune?: Pass; audit?: Pass }): void {
  const path = join(dotfiles, "bin", "wt-all");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\t%s\\n' "$*" "\${WT_ALL_RAW:-unset}" >> ${shQuote(callsFile)}
if [ "$1" = "prune-audit" ]; then
${passBody(passes.audit ?? {})}
fi
${passBody(passes.prune ?? {})}
`,
  );
  chmodSync(path, 0o755);
}

function writeStub(name: string, script: string): void {
  const path = join(stubs, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function calls(): string[] {
  return readLines(callsFile);
}

interface Todo {
  title: string;
  notes: string;
}

// What `open` was handed, read back as the to-do Things would have created.
function todos(): Todo[] {
  return readLines(todosFile).map((url) => {
    const parsed = new URL(url);
    return {
      title: parsed.searchParams.get("title") ?? "",
      notes: parsed.searchParams.get("notes") ?? "",
    };
  });
}

// The script's own status lines. The reporter logs through gum too, and those
// lines say what it filed rather than what this decided.
function logLines(): string[] {
  return readLines(gumFile).filter((line) => !line.includes("to-do"));
}

function latch(job: string): string | undefined {
  const path = join(state, "dotfiles", `${job}.status`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").replace(/\n+$/, "");
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "worktree-prune-"));
  stubs = join(sandbox, "stub");
  dotfiles = join(sandbox, "dotfiles");
  state = join(sandbox, "state");
  callsFile = join(sandbox, "wt-all-calls");
  todosFile = join(sandbox, "todos");
  gumFile = join(sandbox, "gum");
  mkdirSync(stubs);
  mkdirSync(join(dotfiles, "bin"), { recursive: true });

  // A drift run files a Things to-do, and on the Mac this suite also runs on
  // that is a real to-do in the real Today list. The drift path is one example
  // away at all times, so `open` and `osascript` are not optional.
  writeStub("open", `#!/bin/sh\nprintf '%s\\n' "$2" >> ${shQuote(todosFile)}\n`);
  writeStub("gum", `#!/bin/sh\nprintf '%s\\t%s\\n' "$3" "$4" >> ${shQuote(gumFile)}\n`);
  writeStub("osascript", "#!/bin/sh\nexit 0\n");

  // A to-do names the machine it was filed from and is keyed on the hardware, so
  // both answers come from a stub rather than from whichever machine is running
  // the suite.
  writeStub("scutil", `#!/bin/sh\nprintf '%s\\n' ${shQuote(MACHINE)}\n`);
  writeStub("ioreg", `#!/bin/sh\nprintf '"IOPlatformUUID" = "%s"\\n' 0000-TEST\n`);

  // Nothing but the stubs is reachable, so a call that escapes one finds no
  // command at all rather than this machine's. It also keeps git off the path,
  // which pins the revision to "unknown" for every example that does not put it
  // back.
  process.env.PATH = stubs;
  process.env.HOME = sandbox;
  process.env.DOTFILES_HOME = dotfiles;
  process.env.XDG_STATE_HOME = state;
  process.env.THINGS_DATABASE = join(sandbox, "things.sqlite");
  delete process.env.PROJECTS;
  delete process.env.WT_PRUNE_MIN_AGE;

  // A stub that failed to shadow the real command would file real to-dos, so
  // prove the shadowing before every example rather than discovering it from
  // the Today list.
  Bun.spawnSync({ cmd: ["open", "-g", "stub-probe"], env: process.env });
  const filed = readFileSync(todosFile, "utf8");
  if (!filed.startsWith("stub-probe")) throw new Error(`open resolved to ${filed}`);
  rmSync(todosFile);
});

afterEach(() => {
  restore("PATH", environment.PATH);
  restore("HOME", environment.HOME);
  restore("DOTFILES_HOME", environment.DOTFILES_HOME);
  restore("XDG_STATE_HOME", environment.XDG_STATE_HOME);
  restore("THINGS_DATABASE", environment.THINGS_DATABASE);
  restore("PROJECTS", environment.PROJECTS);
  restore("WT_PRUNE_MIN_AGE", environment.WT_PRUNE_MIN_AGE);
  rmSync(sandbox, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function spawnPrune(): { stdout: string; stderr: string; status: number } {
  const run = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT],
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), status: run.exitCode };
}

const MACHINE = "Testbox";

const LEAK = "bendrucker/dotfiles\tfeature\tintegrated (empty)\t/wt/feature\n";
const SECOND_LEAK = "other/repo\tsecond\tmerged PR survived\t/wt/second\n";

describe("the prune pass", () => {
  test("files a to-do naming the failure and stops before the audit", async () => {
    stubWtAll({
      prune: { stdout: "REPO  WORKTREES\n", stderr: "9 scanned · 1 failed\n", status: 3 },
      audit: { stdout: LEAK },
    });

    expect(await main()).toBe(1);
    // The audit re-derives the survivor set this prune should have produced, so
    // a prune that did not finish must not be audited.
    expect(calls()).toEqual(["prune --before\tunset"]);

    const [todo] = todos();
    expect(todos()).toHaveLength(1);
    expect(todo.title).toBe(`Nightly worktree prune failed on ${MACHINE}`);
    expect(todo.notes).toContain("```sh\nwt all prune --before\n```");
    expect(todo.notes).toContain("## Error Output");
    // stderr is merged into stdout, so the diagnosis reaches the to-do
    // alongside the table.
    expect(todo.notes).toContain("REPO  WORKTREES");
    expect(todo.notes).toContain("9 scanned · 1 failed");
  });

  test("leaves the audit latches untouched when the prune fails", async () => {
    stubWtAll({ prune: { status: 1 } });

    expect(await main()).toBe(1);
    expect(latch("worktree-prune")).toMatch(/^failed [0-9a-f]{12}$/);
    expect(latch("wt-prune-audit-failed")).toBeUndefined();
    expect(latch("wt-prune-drift")).toBeUndefined();
  });

  // Run as a subprocess so the echoed log lands in a pipe rather than in this
  // suite's own output.
  test("keeps the last 100 lines of a long prune log, uncoloured", () => {
    const lines = Array.from({ length: 150 }, (_, index) => `${ESC}[31mline ${index}${ESC}[0m`);
    stubWtAll({ prune: { stdout: `${lines.join("\n")}\n`, status: 1 } });

    expect(spawnPrune().status).toBe(1);
    const [todo] = todos();
    expect(todo.notes).toContain("line 149");
    expect(todo.notes).toContain("line 50");
    expect(todo.notes).not.toContain("line 49");
    expect(todo.notes).not.toContain(ESC);
  });

  // A status alone would leave the nightly failure with no stated reason, so
  // the unrunnable path reaches the to-do as text.
  test("reports a wt-all it cannot run", async () => {
    expect(await main()).toBe(1);

    const [todo] = todos();
    expect(todo.title).toBe(`Nightly worktree prune failed on ${MACHINE}`);
    expect(todo.notes).toContain(join(dotfiles, "bin", "wt-all"));
  });

  // The reporter travels with the script, and only wt-all is resolved under
  // $DOTFILES_HOME.
  test("defaults $DOTFILES_HOME to ~/.dotfiles", async () => {
    delete process.env.DOTFILES_HOME;
    dotfiles = join(sandbox, ".dotfiles");
    mkdirSync(join(dotfiles, "bin"), { recursive: true });
    stubWtAll({ audit: { stdout: LEAK } });

    expect(await main()).toBe(0);
    expect(calls()).toEqual(["prune --before\tunset", "prune-audit\t1"]);
    expect(todos()[0].title).toBe(`Worktree prune leaked 1 worktree on ${MACHINE}`);
  });

  test("clears the prune latch on a green prune", async () => {
    stubWtAll({});

    expect(await main()).toBe(0);
    expect(latch("worktree-prune")).toBe("ok");
    expect(todos()).toEqual([]);
  });

  test("logs each step of a clean run", async () => {
    stubWtAll({});

    await main();
    expect(logLines()).toEqual([
      "info\tRunning worktree prune",
      "info\tWorktree prune completed successfully",
      "info\tAuditing for prune drift",
      "info\tNo prune drift",
    ]);
  });
});

describe("the audit pass", () => {
  test("asks for raw rows, and only for the audit", async () => {
    stubWtAll({});

    await main();
    expect(calls()).toEqual(["prune --before\tunset", "prune-audit\t1"]);
  });

  test("clears the audit latch when the audit runs clean", async () => {
    stubWtAll({});

    expect(await main()).toBe(0);
    expect(latch("wt-prune-audit-failed")).toBe("ok");
    expect(latch("wt-prune-drift")).toBe("ok");
  });

  // `wt all` returns nonzero when any repo failed while the repos that answered
  // still emitted their findings, so both to-dos come out of one run.
  test("reports an audit that could not run and still reports what it found", async () => {
    stubWtAll({
      audit: { stdout: LEAK, stderr: "some/repo:\n  fatal: not a git repository\n", status: 1 },
    });

    expect(await main()).toBe(0);
    const [failed, drift] = todos();
    expect(todos()).toHaveLength(2);
    expect(failed.title).toBe(`Worktree prune audit could not run on ${MACHINE}`);
    expect(failed.notes).toContain("```sh\nwt all prune-audit\n```");
    expect(failed.notes).toContain("fatal: not a git repository");
    expect(failed.notes).toContain("The drift tripwire itself failed in one or more repos");
    expect(drift.title).toBe(`Worktree prune leaked 1 worktree on ${MACHINE}`);
  });

  // stdout and stderr are captured apart, unlike the prune's, because anything
  // the audit said about itself would parse as a finding.
  test("keeps the audit's own diagnostics out of the findings", async () => {
    stubWtAll({ audit: { stderr: "repo\tbranch\treason\t/path\n", status: 1 } });

    expect(await main()).toBe(0);
    expect(todos()).toHaveLength(1);
    expect(todos()[0].title).toBe(`Worktree prune audit could not run on ${MACHINE}`);
    expect(logLines()).toContain("info\tNo prune drift");
  });

  test("files the unparsable output without touching the drift latch", async () => {
    stubWtAll({ audit: { stdout: "some/repo unexpected free-form line\n" } });

    expect(await main()).toBe(0);
    const [todo] = todos();
    expect(todos()).toHaveLength(1);
    expect(todo.title).toBe(`Worktree prune audit output could not be parsed on ${MACHINE}`);
    expect(todo.notes).toContain("```sh\nWT_ALL_RAW=1 wt all prune-audit\n```");
    expect(todo.notes).toContain("some/repo unexpected free-form line");
    expect(todo.notes).toContain("no line of it parsed as a finding");
    // Filing a "leaked 0" to-do under the drift job would latch it and suppress
    // the next real drift.
    expect(latch("wt-prune-drift")).toBeUndefined();
    expect(logLines()).toContain("error\tprune audit output could not be parsed");
  });

  // Repos that could not be audited and output that parsed as nothing are two
  // separate things to fix, and the old latch on the shared job name filed the
  // first and lost the second. They are two causes now, so both are filed.
  test("files each condition when the audit both fails and prints nothing parsable", async () => {
    stubWtAll({ audit: { stdout: "free-form\n", stderr: "boom\n", status: 1 } });

    expect(await main()).toBe(0);
    expect(todos().map((todo) => todo.title)).toEqual([
      `Worktree prune audit could not run on ${MACHINE}`,
      `Worktree prune audit output could not be parsed on ${MACHINE}`,
    ]);
    expect(latch("wt-prune-audit-failed")).toMatch(/^failed [0-9a-f]{12}$/);
  });
});

// A refused `open` means nothing was recorded anywhere a person will see it.
// Carrying the filer's own status out says that, where the 1 a reported failure
// already exits with, or the 0 a drift report does, reads as a handled run.
describe("a filing Things refused", () => {
  test.each([
    { name: "the prune failed", stubs: { prune: { status: 1 } } },
    { name: "the audit could not run", stubs: { audit: { stderr: "boom\n", status: 1 } } },
    { name: "the audit printed nothing parsable", stubs: { audit: { stdout: "free-form\n" } } },
    { name: "the audit found drift", stubs: { audit: { stdout: LEAK } } },
  ])("carries the refusal out when $name", async ({ stubs }) => {
    stubWtAll(stubs);
    writeStub("open", "#!/bin/sh\nexit 7\n");

    expect(await main()).toBe(7);
  });
});

describe("drift", () => {
  test("names each leaked worktree and still exits 0", async () => {
    stubWtAll({ audit: { stdout: LEAK + SECOND_LEAK } });

    expect(await main()).toBe(0);
    const [todo] = todos();
    expect(todo.title).toBe(`Worktree prune leaked 2 worktrees on ${MACHINE}`);
    expect(todo.notes).toContain("## Leaked worktrees");
    expect(todo.notes).toContain("bendrucker/dotfiles  feature  integrated (empty)");
    expect(todo.notes).toContain("other/repo           second   merged PR survived");
    expect(todo.notes).toContain("cd '/wt/feature' && wt list");
    expect(todo.notes).toContain("cd '/wt/second' && wt list");
    expect(todo.notes).toContain("## What to do");
    expect(logLines()).toContain("warn\tprune drift detected");
  });

  test("rebuilds each repo path under the discovery root", async () => {
    process.env.PROJECTS = "/elsewhere/src";
    stubWtAll({ audit: { stdout: LEAK } });

    await main();
    expect(todos()[0].notes).toContain("cd '/elsewhere/src/bendrucker/dotfiles'");
  });

  test("defaults the discovery root to $HOME/src", async () => {
    stubWtAll({ audit: { stdout: LEAK } });

    await main();
    expect(todos()[0].notes).toContain(`cd '${join(sandbox, "src", "bendrucker/dotfiles")}'`);
  });

  // The commands in the to-do reproduce the guard the nightly run applied
  // rather than worktrunk's default, and the guard reaches them as text: it is
  // never passed to either pass.
  test("reproduces the min-age guard the run applied", async () => {
    process.env.WT_PRUNE_MIN_AGE = "3d";
    stubWtAll({ audit: { stdout: LEAK } });

    await main();
    expect(todos()[0].notes).toContain("wt step prune --dry-run --min-age '3d'");
    expect(calls()).toEqual(["prune --before\tunset", "prune-audit\t1"]);
  });

  test("defaults the min-age guard to a day", async () => {
    stubWtAll({ audit: { stdout: LEAK } });

    await main();
    expect(todos()[0].notes).toContain("wt step prune --dry-run --min-age '1d'");
  });

  test("clears the drift latch when nothing leaks", async () => {
    stubWtAll({});

    expect(await main()).toBe(0);
    expect(latch("wt-prune-drift")).toBe("ok");
    expect(todos()).toEqual([]);
  });

  // Drift is a standing finding rather than a break: the same leak set stays
  // quiet while the to-do stands, and a worktree that leaks later reopens it.
  test("stays quiet while the same worktrees leak", async () => {
    stubWtAll({ audit: { stdout: LEAK } });

    await main();
    await main();
    expect(todos()).toHaveLength(1);
  });

  test("files again when another worktree leaks", async () => {
    stubWtAll({ audit: { stdout: LEAK } });
    await main();

    stubWtAll({ audit: { stdout: LEAK + SECOND_LEAK } });
    await main();

    expect(todos().map((todo) => todo.title)).toEqual([
      `Worktree prune leaked 1 worktree on ${MACHINE}`,
      `Worktree prune leaked 2 worktrees on ${MACHINE}`,
    ]);
  });
});

describe("the revision", () => {
  function useRealGit(): void {
    const git = Bun.which("git", { PATH: environment.PATH });
    if (!git) throw new Error("git is not on PATH");
    symlinkSync(git, join(stubs, "git"));
  }

  function commit(repo: string): string {
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      Bun.spawnSync({
        cmd: ["git", "-C", repo, ...args],
        env: {
          ...process.env,
          PATH: environment.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    git("init", "--quiet");
    git("commit", "--allow-empty", "--quiet", "-m", "root");
    return git("rev-parse", "--short", "HEAD").stdout.toString().trim();
  }

  test("reads the revision from $DOTFILES_HOME", async () => {
    useRealGit();
    const revision = commit(dotfiles);
    stubWtAll({ prune: { status: 1 } });

    await main();
    expect(todos()[0].notes).toContain(`- **Revision:** ${revision}`);
  });

  test("reports an unknown revision where $DOTFILES_HOME is no repo", async () => {
    useRealGit();
    stubWtAll({ prune: { status: 1 } });

    await main();
    expect(todos()[0].notes).toContain("- **Revision:** unknown");
  });

  test("reports an unknown revision where git is absent", async () => {
    stubWtAll({ prune: { status: 1 } });

    await main();
    expect(todos()[0].notes).toContain("- **Revision:** unknown");
  });
});

describe("the executable", () => {
  // /tmp/worktree-prune.log is the only record of the run, so both of the
  // prune's streams reach stdout. The audit's output goes to the to-do instead:
  // on stdout its rows would be indistinguishable from the prune's table.
  test("echoes the prune pass and nothing else", () => {
    stubWtAll({
      prune: { stdout: "REPO  WORKTREES\ndotfiles  3\n", stderr: "9 scanned · 3 with output\n" },
      audit: { stdout: LEAK },
    });

    const run = spawnPrune();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("REPO  WORKTREES");
    expect(run.stdout).toContain("9 scanned · 3 with output");
    expect(run.stdout).not.toContain("/wt/feature");
    // The child's stderr is a pipe this reads rather than an inherited one:
    // `wt all` redraws a spinner onto a terminal, and those escapes would ride
    // into the to-do.
    expect(run.stderr).not.toContain("9 scanned · 3 with output");
  });

  // Through a real pipeline, not spawnSync's own pipe: a `process.stdout.write`
  // followed by `process.exit` delivers exactly one 131072-byte buffer and drops
  // the rest, which is how the launchd log would lose a fleet-wide table.
  test("echoes a prune log longer than a pipe buffer in full", () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `repo-${index}  3  4`);
    const log = join(sandbox, "prune-log");
    writeFileSync(log, `${lines.join("\n")}\n`);
    // An absolute cat, because $PATH holds nothing but the stub directory.
    writeFileSync(
      join(dotfiles, "bin", "wt-all"),
      `#!/bin/sh\n[ "$1" = "prune-audit" ] && exit 0\n/bin/cat ${shQuote(log)}\n`,
    );
    chmodSync(join(dotfiles, "bin", "wt-all"), 0o755);

    const piped = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", `'${process.execPath}' '${SCRIPT}' | /bin/cat`],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const echoed = piped.stdout.toString().split("\n").filter(Boolean);
    expect(echoed).toHaveLength(lines.length);
    expect(echoed.at(-1)).toBe("repo-19999  3  4");
  });

  test("exits 1 on a failed prune", () => {
    stubWtAll({ prune: { stdout: "boom\n", status: 2 } });

    expect(spawnPrune().status).toBe(1);
  });

  test("exits 0 on a run that filed drift", () => {
    stubWtAll({ audit: { stdout: LEAK } });

    expect(spawnPrune().status).toBe(0);
  });
});
