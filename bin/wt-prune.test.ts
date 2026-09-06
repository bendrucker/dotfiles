import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "../scripts/lib/worktree-state.ts";
import {
  alignColumns,
  type Candidate,
  checklist,
  classifySurvivor,
  type Decision,
  type Options,
  parseOptions,
  plural,
  type Report,
  type SurvivorState,
} from "./wt-prune";

// `step prune` reports nothing integrated, so every survivor reaches the forge
// pass. `remove` only logs, so a dry run that wrongly removed leaves a trace.
// `config state default-branch get` names the branch wt would refuse to remove.
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

// $GUM_CHOOSE picks the offered lines it matches, and nothing when it is unset,
// which is what escape or an empty selection produces. $GUM_CONFIRM_RC is the
// answer to the local-only confirm. Present on the non-interactive path too, so
// an accidental call cannot escape to the real binary and draw a checklist at
// whoever is running these.
const GUM_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
printf 'gum %s\\n' "$*" >>"$GUM_LOG"
case "$1" in
  choose)
    offered="$(cat)"
    [ -n "\${GUM_CHOOSE:-}" ] && printf '%s\\n' "$offered" | grep -F "$GUM_CHOOSE"
    ;;
  confirm) exit "\${GUM_CONFIRM_RC:-0}" ;;
esac
exit 0
`;

const SCRIPT = join(import.meta.dir, "wt-prune");
const STUBBED = ["wt", "gh", "gum"];
const environment = { PATH: process.env.PATH, cwd: process.cwd() };

let sandbox: string;
let repo: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-prune-"));
  repo = join(sandbox, "repo");

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeStub(join(stubs, "wt"), WT_STUB);
  writeStub(join(stubs, "gh"), GH_STUB);
  writeStub(join(stubs, "gum"), GUM_STUB);

  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.WT_LIST_JSON = join(sandbox, "list.json");
  process.env.WT_REMOVE_LOG = join(sandbox, "removed.log");
  process.env.WT_STEP_LOG = join(sandbox, "step.log");
  process.env.GH_LOG = join(sandbox, "gh.log");
  process.env.GUM_LOG = join(sandbox, "gum.log");
  process.env.PR_STATE_FILE = join(sandbox, "pr_state");
  delete process.env.WT_ALL;
  delete process.env.WT_PRUNE_MIN_AGE;

  for (const log of ["WT_REMOVE_LOG", "WT_STEP_LOG", "GH_LOG", "GUM_LOG"]) {
    writeFileSync(process.env[log] as string, "");
  }
  writeFileSync(process.env.PR_STATE_FILE, "MERGED");

  // A real repo with a github origin, so the host resolution routes the forge
  // lookup to gh. Worktree contents are canned in the fixtures below.
  mkdirSync(repo);
  git(["init", "-q", "-b", "main", repo]);
  git(["-C", repo, "remote", "add", "origin", "https://github.com/test/repo.git"]);

  proveStubs();
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  for (const name of [
    "GUM_CHOOSE",
    "GUM_CONFIRM_RC",
    "WT_LIST_JSON",
    "WT_REMOVE_LOG",
    "WT_STEP_LOG",
    "GH_LOG",
    "GUM_LOG",
    "PR_STATE_FILE",
    "WT_ALL",
    "WT_PRUNE_MIN_AGE",
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

function prune(args: string[], env: Record<string, string> = {}): Result {
  const run = Bun.spawnSync({
    cmd: [SCRIPT, ...args],
    cwd: repo,
    env: { ...process.env, ...env },
    stdin: "ignore",
  });
  return {
    status: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function log(name: "WT_REMOVE_LOG" | "WT_STEP_LOG" | "GH_LOG" | "GUM_LOG"): string {
  return readFileSync(process.env[name] as string, "utf8");
}

function prStateIs(state: string): void {
  writeFileSync(process.env.PR_STATE_FILE as string, state);
}

function listing(entries: unknown[]): void {
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
// shape): the integration pass misses it, the forge state carries the removal.
function mergedSurvivor(): void {
  listing([
    worktree({ branch: "main", is_main: true, is_current: true, path: "/repo" }),
    worktree({ branch: "feature-x", path: "/repo/.worktrees/feature-x" }),
  ]);
}

// A repo whose main worktree sits on a topic branch leaves the default branch
// checked out in a linked worktree. `wt step prune` skips that branch, it has
// no PR, and `wt remove` refuses it, so the age pass used to retry a removal
// that always fails.
function defaultBranchWorktree(): void {
  listing([
    worktree({ branch: "topic", is_main: true, is_current: true, path: "/repo" }),
    worktree({ branch: "main", path: "/repo/.worktrees/main" }),
  ]);
}

describe("classifySurvivor decision matrix", () => {
  // A remove decision carries a mode (delete-branch / keep-branch) that the
  // passes map to the wt remove flags. keep/defer carry no mode. Branch
  // deletion keys off the mode token, and the reason stays display-only.
  const survivor = (fields: Partial<SurvivorState>): SurvivorState => ({
    prState: "",
    onRemote: false,
    clean: true,
    isCurrent: false,
    beforeEnabled: false,
    ageExceeded: false,
    ...fields,
  });

  const cases: [string, SurvivorState, Decision][] = [
    // Merged wins over a dirty tree and over local commits ahead. A squash
    // merge leaves both, so only the MERGED forge state proves it landed, and
    // the landed branch is safe to delete.
    [
      "merged beats a dirty local-only tree",
      survivor({ prState: "MERGED", clean: false, beforeEnabled: true, ageExceeded: true }),
      { action: "remove", reason: "merged", mode: "delete-branch" },
    ],
    [
      "merged and clean",
      survivor({ prState: "MERGED", onRemote: true }),
      { action: "remove", reason: "merged", mode: "delete-branch" },
    ],
    // Closed, backed up on a remote, clean: recoverable, so remove.
    [
      "closed, on a remote and clean",
      survivor({ prState: "CLOSED", onRemote: true }),
      { action: "remove", reason: "closed, recoverable", mode: "delete-branch" },
    ],
    // Closed but local-only or dirty: keep, the work is only here.
    [
      "closed and local-only",
      survivor({ prState: "CLOSED" }),
      { action: "keep", reason: "local-only" },
    ],
    [
      "closed and dirty",
      survivor({ prState: "CLOSED", onRemote: true, clean: false }),
      { action: "keep", reason: "dirty & closed" },
    ],
    [
      "an open PR is preserved",
      survivor({ prState: "OPEN", onRemote: true }),
      { action: "keep", reason: "open PR" },
    ],
    // The current worktree is never force-removed, even when merged.
    [
      "the current worktree",
      survivor({ prState: "MERGED", clean: false, isCurrent: true }),
      { action: "keep", reason: "current worktree" },
    ],
    // Pushed with no PR and not yet aged: defer, do not auto-remove.
    [
      "no PR, pushed, not yet aged",
      survivor({ onRemote: true, beforeEnabled: true }),
      { action: "defer", reason: "local-only" },
    ],
    // Old and clean with no decisive PR state: remove but keep the branch, so
    // committed work survives.
    [
      "no PR, aged out",
      survivor({ beforeEnabled: true, ageExceeded: true }),
      { action: "remove", reason: "aged out", mode: "keep-branch" },
    ],
    // Age applies whatever the PR state: an old, clean open-PR checkout ages out.
    [
      "an open PR that aged out",
      survivor({ prState: "OPEN", onRemote: true, beforeEnabled: true, ageExceeded: true }),
      { action: "remove", reason: "aged out", mode: "keep-branch" },
    ],
    // The age pass is masked under -i, which reaches the classifier as a
    // disabled before pass so the candidate falls through to the checklist.
    [
      "aged out with the age pass masked off",
      survivor({ ageExceeded: true }),
      { action: "defer", reason: "local-only" },
    ],
  ];

  for (const [name, state, expected] of cases) {
    test(name, () => {
      expect(classifySurvivor(state)).toEqual(expected);
    });
  }
});

describe("parseDuration", () => {
  test("converts 2w to seconds", () => {
    expect(parseDuration("2w")).toBe(1209600);
  });

  test("reads every unit it accepts", () => {
    expect([
      parseDuration("2h"),
      parseDuration("3d"),
      parseDuration("1mo"),
      parseDuration("1y"),
    ]).toEqual([7200, 259200, 2592000, 31536000]);
  });

  test("refuses a spec it does not understand, so callers can stop", () => {
    for (const spec of ["bogus", "30min", "2W", "1.5d", "d", ""]) {
      expect(parseDuration(spec)).toBeUndefined();
    }
  });
});

describe("option parsing", () => {
  test("--before with no duration of its own enables the age pass at a month", () => {
    const parsed = parseOptions(["--before"]);
    expect(parsed).toEqual({
      ok: true,
      options: { dryRun: false, interactive: false, minAge: "1d", before: 2592000 },
    });
  });

  test("--before keeps the flag behind it", () => {
    const parsed = parseOptions(["--before", "--dry-run"]);
    expect(parsed.ok && parsed.options).toMatchObject({ dryRun: true, before: 2592000 });
  });

  test("--before takes a duration in either form", () => {
    expect(parseOptions(["--before", "2w"]).ok && parseOptions(["--before", "2w"]).options.before)
      .toBe(1209600);
    expect(parseOptions(["--before=2w"]).ok && parseOptions(["--before=2w"]).options.before)
      .toBe(1209600);
  });

  test("a duration it cannot read is refused rather than rounded to a default", () => {
    const parsed = parseOptions(["--before", "30min"]);
    expect(parsed).toEqual({ ok: false, message: "cannot read --before=30min as a duration" });
  });

  test("an unknown flag is refused rather than forwarded to wt step prune", () => {
    const parsed = parseOptions(["--dryrun"]);
    expect(parsed.ok).toBe(false);
  });

  test("--min-age with nothing to read is refused", () => {
    expect(parseOptions(["--min-age"]).ok).toBe(false);
    expect(parseOptions(["--min-age", "--dry-run"]).ok).toBe(false);
  });

  test("$WT_PRUNE_MIN_AGE stands in for an unset --min-age", () => {
    process.env.WT_PRUNE_MIN_AGE = "3d";
    expect(parseOptions([]).ok && parseOptions([]).options.minAge).toBe("3d");
  });
});

describe("summary wording", () => {
  test("pluralises what it removed", () => {
    expect([
      plural(1, "worktree"),
      plural(3, "worktree"),
      plural(1, "branch"),
      plural(2, "branch"),
    ]).toEqual(["1 worktree", "3 worktrees", "1 branch", "2 branches"]);
  });

  test("aligns a table down its columns", () => {
    expect(alignColumns([["a", "bb"], ["ccc", "d"]])).toEqual(["a    bb", "ccc  d"]);
  });
});

describe("prune (black box)", () => {
  test("dry-run prints a reasons table and removes nothing", () => {
    mergedSurvivor();
    const result = prune(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DECISION");
    expect(result.stdout).toContain("REASON");
    expect(result.stdout).toContain("feature-x");
    expect(result.stdout).toContain("remove");
    expect(result.stdout).toContain("merged");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  test("dry-run -i refuses without a terminal and removes nothing", () => {
    mergedSurvivor();
    const result = prune(["--dry-run", "-i"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a terminal");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  test("-i refuses under wt all", () => {
    mergedSurvivor();
    const result = prune(["-i"], { WT_ALL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot run under wt all");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  // The removal half of the mode contract: a real removal passes the flags the
  // decision's mode implies, so branch deletion tracks the decision rather than
  // the wording of the reason.
  test("force-deletes the branch of a merged worktree", () => {
    mergedSurvivor();
    prStateIs("MERGED");
    const result = prune([]);
    expect(result.status).toBe(0);
    // Nothing but the summary reaches stdout, which is the line `wt all` parses.
    expect(result.stdout).toBe("1 worktree\n");
    expect(log("WT_REMOVE_LOG")).toContain("--force --force-delete feature-x");
  });

  test("removes an aged-out worktree without deleting its branch", () => {
    mergedSurvivor();
    prStateIs("");
    const result = prune(["--before", "1mo"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("worktree");
    expect(log("WT_REMOVE_LOG")).toContain("--foreground feature-x");
    expect(log("WT_REMOVE_LOG")).not.toContain("force-delete");
  });

  // The coupling the audit rests on: it models a guard the pruner must actually
  // be applying. Drop the flag and the two disagree silently.
  test("passes the configured min-age through to wt step prune", () => {
    mergedSurvivor();
    const result = prune(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feature-x");
    expect(log("WT_STEP_LOG")).toContain("--min-age 1d");
  });

  test("forwards an overridden min-age exactly once", () => {
    mergedSurvivor();
    const result = prune(["--dry-run", "--min-age", "3d"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feature-x");
    expect(log("WT_STEP_LOG")).toContain("--min-age 3d");
    expect(log("WT_STEP_LOG")).not.toContain("--min-age 1d");
  });

  test("never attempts to remove a default-branch worktree that aged out", () => {
    defaultBranchWorktree();
    prStateIs("");
    const result = prune(["--before", "1mo"]);
    expect(result.status).toBe(0);
    expect(log("WT_REMOVE_LOG")).toBe("");
    // Skipped before the forge lookup, which has no PR to find for it anyway.
    expect(log("GH_LOG")).toBe("");
  });

  test("dry-run explains the default-branch worktree as kept", () => {
    defaultBranchWorktree();
    prStateIs("");
    const result = prune(["--dry-run", "--before", "1mo"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default branch");
    expect(result.stdout).toContain("keep");
  });

  test("prints nothing when there is nothing to remove", () => {
    listing([worktree({ branch: "main", is_main: true, is_current: true, path: "/repo" })]);
    const result = prune([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  // The gate that keeps a fleet sweep of single-worktree repos off the network.
  test("consults no forge when no linked worktree survives", () => {
    listing([worktree({ branch: "main", is_main: true, is_current: true, path: "/repo" })]);
    prune([]);
    expect(log("GH_LOG")).toBe("");
  });

  // A machine-parsed format: bin/wt-all matches this line and adds the two
  // numbers into the fleet totals.
  test("reports tab-separated counts under wt all", () => {
    mergedSurvivor();
    prStateIs("MERGED");
    const result = prune(["--dry-run"], { WT_ALL: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("1\t0\n");
  });

  test("refuses a duration it cannot read instead of pruning differently", () => {
    mergedSurvivor();
    const result = prune(["--before", "30min"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("30min");
    expect(log("WT_STEP_LOG")).toBe("");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  test("refuses an unknown flag instead of forwarding it to wt step prune", () => {
    mergedSurvivor();
    const result = prune(["--dryrun"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--dryrun");
    expect(log("WT_STEP_LOG")).toBe("");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });
});

// gum drives this, so it never runs unattended and the shell version had no
// coverage of it at all. The label alignment is what maps a selection back to
// the handle `wt remove` is given, and the confirm is the only thing between a
// local-only branch and a force-delete.
describe("interactive checklist", () => {
  const options: Options = { dryRun: false, interactive: true, minAge: "1d", before: undefined };

  function candidate(handle: string, onRemote: boolean): Candidate {
    return {
      handle,
      row: [handle, handle, "-", onRemote ? "onremote" : "LOCAL-ONLY", "clean"],
      onRemote,
    };
  }

  function pick(candidates: Candidate[], choice?: string, confirmRc?: string): Report {
    if (choice !== undefined) process.env.GUM_CHOOSE = choice;
    if (confirmRc !== undefined) process.env.GUM_CONFIRM_RC = confirmRc;
    const report: Report = { worktrees: 0, branches: 0, reasons: [] };
    checklist(candidates, options, report);
    return report;
  }

  test("selecting nothing removes nothing", () => {
    const report = pick([candidate("feature-x", true)]);
    expect(report.worktrees).toBe(0);
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  test("a selection is removed by its own handle", () => {
    const report = pick([candidate("feature-x", true), candidate("feature-y", true)], "feature-x");
    expect(report.worktrees).toBe(1);
    expect(log("WT_REMOVE_LOG")).toContain("--foreground --force --force-delete feature-x");
    expect(log("WT_REMOVE_LOG")).not.toContain("feature-y");
  });

  test("a selection with a remote copy is not gated on a confirm", () => {
    pick([candidate("feature-x", true)], "feature-x");
    expect(log("GUM_LOG")).not.toContain("confirm");
  });

  test("declining the local-only confirm removes nothing", () => {
    const report = pick([candidate("feature-x", false)], "feature-x", "1");
    expect(report.worktrees).toBe(0);
    expect(log("GUM_LOG")).toContain("no remote copy");
    expect(log("WT_REMOVE_LOG")).toBe("");
  });

  test("a confirmed local-only selection is removed", () => {
    const report = pick([candidate("feature-x", false)], "feature-x", "0");
    expect(report.worktrees).toBe(1);
    expect(log("WT_REMOVE_LOG")).toContain("feature-x");
  });

  test("a dry run counts the selection without removing it", () => {
    const report: Report = { worktrees: 0, branches: 0, reasons: [] };
    process.env.GUM_CHOOSE = "feature-x";
    checklist([candidate("feature-x", true)], { ...options, dryRun: true }, report);
    expect(report.worktrees).toBe(1);
    expect(log("WT_REMOVE_LOG")).toBe("");
  });
});
