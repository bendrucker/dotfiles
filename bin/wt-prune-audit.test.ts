import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, type Facts, graceSeconds } from "./wt-prune-audit";

// `list` feeds the canned survivor set the audit re-derives from, and `config
// state default-branch get` names the branch wt would refuse to remove. `step`
// and `remove` are here because the audit must never reach either, and a
// regression that did would leave a trace in these logs.
const WT_STUB = `#!/usr/bin/env bash
case "$1" in
  --stub-check) echo "wt stub"; exit 0 ;;
  step)   printf 'step %s\\n' "$*" >>"$WT_STEP_LOG"; echo "[]" ;;
  list)   cat "$WT_LIST_JSON" ;;
  remove) printf 'remove %s\\n' "$*" >>"$WT_REMOVE_LOG" ;;
  config) echo main ;;
esac
exit 0
`;

// `gh pr view <branch> --json state,number --jq …` resolves to the state under
// test. An empty state file mimics a branch with no PR, where real gh exits
// nonzero printing nothing. Every call is logged, so a case can assert the
// forge was never consulted.
const GH_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gh stub"; exit 0; }
printf 'gh %s\\n' "$*" >>"$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  state="$(cat "$PR_STATE_FILE")"
  [ -n "$state" ] && printf '%s\\t42\\n' "$state"
fi
exit 0
`;

const SCRIPT = join(import.meta.dir, "wt-prune-audit");
const STUBBED = ["wt", "gh"];
const environment = { PATH: process.env.PATH };

let sandbox: string;
let repo: string;
// A real linked worktree, so the age lookup resolves a per-worktree git dir (a
// .git *file* pointing at .git/worktrees/<name>) rather than the repo's own
// .git. Reading the repo's dir instead would date every worktree to the clone,
// which the grace cases have to be able to tell apart.
let linked: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-prune-audit-"));
  repo = join(sandbox, "repo");
  linked = join(sandbox, "linked");

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeStub(join(stubs, "wt"), WT_STUB);
  writeStub(join(stubs, "gh"), GH_STUB);

  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.WT_LIST_JSON = join(sandbox, "list.json");
  process.env.WT_REMOVE_LOG = join(sandbox, "removed.log");
  process.env.WT_STEP_LOG = join(sandbox, "step.log");
  process.env.GH_LOG = join(sandbox, "gh.log");
  process.env.PR_STATE_FILE = join(sandbox, "pr_state");
  delete process.env.WT_PRUNE_MIN_AGE;
  delete process.env.WT_PRUNE_DRIFT_GRACE;

  for (const log of ["WT_REMOVE_LOG", "WT_STEP_LOG", "GH_LOG"]) {
    writeFileSync(process.env[log] as string, "");
  }
  writeFileSync(process.env.PR_STATE_FILE, "MERGED");

  // A github origin, so the host resolution routes the forge lookup to gh. Its
  // own identity and signing setting, because a runner with no global gitconfig
  // cannot commit at all.
  git(["init", "-q", "-b", "main", repo]);
  git(["-C", repo, "config", "user.email", "spec@example.test"]);
  git(["-C", repo, "config", "user.name", "Spec"]);
  git(["-C", repo, "config", "commit.gpgsign", "false"]);
  git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  git(["-C", repo, "remote", "add", "origin", "https://github.com/test/repo.git"]);
  git(["-C", repo, "worktree", "add", "-q", "-b", "fresh", linked]);

  proveStubs();
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  for (const name of [
    "WT_LIST_JSON",
    "WT_REMOVE_LOG",
    "WT_STEP_LOG",
    "GH_LOG",
    "PR_STATE_FILE",
    "WT_PRUNE_MIN_AGE",
    "WT_PRUNE_DRIFT_GRACE",
  ]) {
    delete process.env[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function writeStub(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function git(args: string[]): void {
  const run = Bun.spawnSync({ cmd: ["git", ...args], env: process.env, stdin: "ignore" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

// The PATH edit above is the whole isolation these cases have. A stub that did
// not shadow its real binary would let a case reach the network, the forge, or
// a real removal and still look like it passed.
function proveStubs(): void {
  for (const name of STUBBED) {
    const run = Bun.spawnSync({ cmd: [name, "--stub-check"], env: process.env, stdin: "ignore" });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function runAudit(env: Record<string, string> = {}): Result {
  const run = Bun.spawnSync({
    cmd: [SCRIPT],
    cwd: repo,
    env: { ...process.env, ...env },
    stdin: "ignore",
  });
  return { status: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function log(name: "WT_REMOVE_LOG" | "WT_STEP_LOG" | "GH_LOG"): string {
  return readFileSync(process.env[name] as string, "utf8");
}

function prStateIs(state: string): void {
  writeFileSync(process.env.PR_STATE_FILE as string, state);
}

function listing(entries: Record<string, unknown>[]): void {
  writeFileSync(process.env.WT_LIST_JSON as string, JSON.stringify(entries));
}

function worktree(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "worktree",
    is_main: false,
    is_current: false,
    commit: { timestamp: 1000 },
    working_tree: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
    },
    remote: { ahead: 0, behind: 0 },
    ...fields,
  };
}

// A merged survivor whose branch still diverges from main (the squash-merge
// shape): the integration pass misses it, so the forge state is what carries
// the finding.
function mergedSurvivor(): void {
  listing([
    worktree({ branch: "main", is_main: true, is_current: true, path: "/repo", main_state: "is_main" }),
    worktree({ branch: "feature-x", path: "/repo/.worktrees/feature-x", main_state: "diverged" }),
  ]);
}

// The fresh linked worktree the fixture just created, whose git dir dates from
// moments ago.
function youngSurvivor(mainState: string): void {
  listing([worktree({ branch: "fresh", path: linked, main_state: mainState, remote: null })]);
}

describe("the executable", () => {
  // A merged PR proves the work landed however new the checkout is, so the
  // forge rule reports it without consulting the grace period.
  test("flags a merged survivor the prune left behind", () => {
    mergedSurvivor();

    const outcome = runAudit();
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("feature-x\tmerged PR survived\t/repo/.worktrees/feature-x\n");
  });

  // This fixture path does not exist, so the age is unresolvable. An unknown age
  // counts as old enough, keeping a missing clock from masking real drift.
  test("flags an integrated survivor without a forge call", () => {
    listing([
      worktree({ branch: "agent-x", path: "/repo/.worktrees/agent-x", main_state: "integrated", remote: null }),
    ]);

    const outcome = runAudit();
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("agent-x\tintegrated (integrated)\t/repo/.worktrees/agent-x\n");
    // The gating that keeps a fleet-wide sweep off the network for every repo
    // `wt list` already answered for.
    expect(log("GH_LOG")).toBe("");
  });

  // wt step prune skips a worktree for its first day, because one branched off
  // main reads as integrated before any work lands in it. Without the grace
  // period the audit reports every worktree created since the previous run.
  test("ignores an integrated worktree still inside the grace period", () => {
    prStateIs("");
    youngSurvivor("empty");

    expect(runAudit()).toMatchObject({ status: 0, stdout: "" });
  });

  test("flags that same worktree once the grace period is zero", () => {
    youngSurvivor("empty");

    const outcome = runAudit({ WT_PRUNE_DRIFT_GRACE: "0h" });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe(`fresh\tintegrated (empty)\t${linked}\n`);
  });

  // Grace defers the integration rule only. A merged PR is removed at any age,
  // so a young worktree whose PR merged is still a real miss and the forge check
  // has to run even while the integration rule is inside its grace window.
  test("still reports a merged PR on a worktree inside the grace period", () => {
    youngSurvivor("integrated");

    const outcome = runAudit();
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe(`fresh\tmerged PR survived\t${linked}\n`);
  });

  // A grace spelling the duration grammar cannot read must stop the audit rather
  // than silently fall back, which would either bury drift or restore the false
  // positives the grace period exists to remove.
  test("fails loudly on an unparseable grace duration", () => {
    mergedSurvivor();

    const outcome = runAudit({ WT_PRUNE_DRIFT_GRACE: "30min" });
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("cannot parse");
  });

  // A repo whose main worktree sits on a topic branch leaves the default branch
  // checked out in a linked worktree. `wt step prune` skips that branch, it has
  // no PR, and `wt remove` refuses it, so the audit used to file a to-do for it
  // every night.
  test("ignores a default-branch worktree at any age", () => {
    prStateIs("");
    listing([
      worktree({ branch: "topic", is_main: true, is_current: true, path: "/repo", main_state: "is_main" }),
      worktree({ branch: "main", path: linked, main_state: "integrated" }),
    ]);

    expect(runAudit({ WT_PRUNE_DRIFT_GRACE: "0h" })).toMatchObject({ status: 0, stdout: "" });
  });

  test("stays silent when the survivor's PR is still open", () => {
    mergedSurvivor();
    prStateIs("OPEN");

    expect(runAudit()).toMatchObject({ status: 0, stdout: "" });
  });

  // An oracle that removed anything would be reporting on its own work. Its
  // findings have to come from a prune that already ran.
  test("removes nothing and runs no prune pass", () => {
    mergedSurvivor();

    expect(runAudit().stdout).not.toBe("");
    expect(log("WT_REMOVE_LOG")).toBe("");
    expect(log("WT_STEP_LOG")).toBe("");
  });

  // Detached worktrees (agent-*/wf_*) carry no branch, so neither rule can
  // resolve one and the pruner offers them interactively instead.
  test("passes over a worktree with no branch", () => {
    listing([worktree({ branch: "", path: "/repo/.worktrees/wf_1", main_state: "integrated" })]);

    expect(runAudit({ WT_PRUNE_DRIFT_GRACE: "0h" })).toMatchObject({ status: 0, stdout: "" });
    expect(log("GH_LOG")).toBe("");
  });
});

describe("classify", () => {
  const facts = (fields: Partial<Facts>): Facts => ({
    mainState: "diverged",
    grace: 172800,
    age: () => 0,
    forge: () => "",
    ...fields,
  });

  const cases: [string, Facts, string | undefined][] = [
    [
      "integrated and past grace",
      facts({ mainState: "integrated", age: () => 172800 }),
      "integrated (integrated)",
    ],
    // "empty" names the same landed state and travels into the reason, so the
    // to-do says which of the two `wt list` reported.
    ["no commits of its own and past grace", facts({ mainState: "empty", age: () => 999999 }), "integrated (empty)"],
    ["integrated and inside grace", facts({ mainState: "integrated", age: () => 5 }), undefined],
    // An age no clock could resolve reads as old enough, so a filesystem that
    // records no birth time cannot hide drift.
    [
      "integrated with an unreadable age",
      facts({ mainState: "integrated", age: () => undefined }),
      "integrated (integrated)",
    ],
    [
      "merged while still inside grace",
      facts({ mainState: "integrated", age: () => 5, forge: () => "MERGED" }),
      "merged PR survived",
    ],
    ["merged and never integrated", facts({ forge: () => "MERGED" }), "merged PR survived"],
    ["open PR", facts({ forge: () => "OPEN" }), undefined],
    // Closed without merging is not landed work. The pruner removes it only
    // when the tip is backed up, and the audit has no view of that, so an
    // oracle reporting it would fire on every abandoned branch.
    ["closed PR", facts({ forge: () => "CLOSED" }), undefined],
    ["no PR at all", facts({}), undefined],
  ];

  test.each(cases)("%s", (_name, given, expected) => {
    expect(classify(given)).toBe(expected);
  });

  // The integration rule is free and the forge call is a network round trip per
  // survivor, which is what makes a fleet-wide sweep over clean repos cheap.
  test("does not consult the forge once the integration rule answers", () => {
    let asked = 0;
    classify(facts({ mainState: "integrated", age: () => 999999, forge: () => (asked++, "MERGED") }));
    expect(asked).toBe(0);
  });

  // Reading the clock costs a git call per worktree, and a branch that never
  // integrated has no age question to answer.
  test("does not read the clock for a worktree that never integrated", () => {
    let asked = 0;
    classify(facts({ mainState: "diverged", age: () => (asked++, 0) }));
    expect(asked).toBe(0);
  });
});

describe("graceSeconds", () => {
  // The pruner's own guard plus one nightly run, so a worktree counts as drift
  // only once a run that could have removed it has come and gone.
  test("defaults to the prune age floor plus a run interval", () => {
    expect(graceSeconds()).toBe(86400 + 86400);
  });

  test("follows the floor the pruner was configured with", () => {
    process.env.WT_PRUNE_MIN_AGE = "1w";
    expect(graceSeconds()).toBe(604800 + 86400);
  });

  test("takes the override verbatim, with no run interval added", () => {
    process.env.WT_PRUNE_DRIFT_GRACE = "2h";
    expect(graceSeconds()).toBe(7200);
  });

  test("ignores an empty override", () => {
    process.env.WT_PRUNE_DRIFT_GRACE = "";
    expect(graceSeconds()).toBe(86400 + 86400);
  });

  test.each([
    ["the override", { WT_PRUNE_DRIFT_GRACE: "30min" }],
    ["the prune age floor", { WT_PRUNE_MIN_AGE: "yesterday" }],
  ])("answers nothing for a duration %s cannot express", (_name, env) => {
    Object.assign(process.env, env);
    expect(graceSeconds()).toBeUndefined();
  });
});
