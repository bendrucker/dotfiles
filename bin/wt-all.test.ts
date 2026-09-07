import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countsIn,
  discover,
  display,
  failureBlock,
  frame,
  jobs,
  projectsRoot,
  pruneTable,
  type Result,
  roots,
  rowsFor,
  summarize,
} from "./wt-all";

// Answers for one repo come from files named after it, so a case scripts each
// repo's output, diagnostics, and status independently. A missing file is the
// repo that printed nothing, which is most of them on a real sweep. The
// environment it was handed goes to its own log, since $WT_ALL is what a
// wrapped command reads to switch to its terse output.
const WT_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "wt stub"; exit 0; }
printf '%s\\n' "$*" >>"$WT_LOG"
name="$(basename "$2")"
printf '%s WT_ALL=%s\\n' "$name" "\${WT_ALL:-}" >>"$WT_ENV_LOG"
[ -f "$WT_ANSWERS/$name.out" ] && cat "$WT_ANSWERS/$name.out"
[ -f "$WT_ANSWERS/$name.err" ] && cat "$WT_ANSWERS/$name.err" >&2
[ -f "$WT_ANSWERS/$name.rc" ] && exit "$(cat "$WT_ANSWERS/$name.rc")"
exit 0
`;

const GUM_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
printf '%s\\n' "$*" >>"$GUM_LOG"
`;

const SCRIPT = join(import.meta.dir, "wt-all");
const STUBS: Record<string, string> = { wt: WT_STUB, gum: GUM_STUB };

let sandbox: string;
let stubs: string;
let root: string;
let answers: string;
let path: string;
let variables: Record<string, string>;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-all-"));
  stubs = join(sandbox, "stub");
  root = join(sandbox, "src");
  answers = join(sandbox, "answers");
  mkdirSync(stubs);
  mkdirSync(root);
  mkdirSync(answers);

  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), script);
    chmodSync(join(stubs, name), 0o755);
  }

  // The stub directory ahead of the two system ones, which hold neither tool
  // under stub and do hold the bash every stub runs on.
  path = `${stubs}:/usr/bin:/bin`;
  variables = {
    PATH: path,
    PROJECTS: root,
    WT_LOG: join(sandbox, "wt.log"),
    WT_ENV_LOG: join(sandbox, "wt-env.log"),
    WT_ANSWERS: answers,
    GUM_LOG: join(sandbox, "gum.log"),
    // Empty reads as unset, so a value in the ambient environment cannot pick
    // the output format or the concurrency a case runs under.
    WT_ALL_ROOT: "",
    WT_ALL_RAW: "",
    WT_ALL_JOBS: "",
  };

  for (const log of ["WT_LOG", "WT_ENV_LOG", "GUM_LOG"]) {
    writeFileSync(variables[log] as string, "");
  }

  proveStubs();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The PATH these cases hand the script is their whole isolation. A stub that
// did not shadow its real binary would let a case run worktrunk against every
// repo on this machine.
function proveStubs(): void {
  for (const name of Object.keys(STUBS)) {
    const run = Bun.spawnSync({
      cmd: [name, "--stub-check"],
      env: { PATH: path },
      stdin: "ignore",
    });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

interface Answer {
  stdout?: string;
  stderr?: string;
  status?: number;
}

function repo(name: string, answer: Answer = {}): void {
  mkdirSync(join(root, name, ".git"), { recursive: true });
  if (answer.stdout !== undefined) writeFileSync(join(answers, `${name}.out`), answer.stdout);
  if (answer.stderr !== undefined) writeFileSync(join(answers, `${name}.err`), answer.stderr);
  if (answer.status !== undefined) {
    writeFileSync(join(answers, `${name}.rc`), String(answer.status));
  }
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

// Run through bun by path rather than by shebang, so PATH can hold only what
// the case wants the script to find.
function run(args: string[], extra: Record<string, string> = {}): Outcome {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, ...variables, ...extra },
    stdin: "ignore",
  });
  return {
    status: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

function log(name: "WT_LOG" | "WT_ENV_LOG" | "GUM_LOG"): string[] {
  const file = variables[name] as string;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "").sort();
}

// Assigning undefined to process.env stores the string "undefined", so a
// variable that was unset has to be removed rather than written back.
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("roots", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const name of ["WT_ALL_ROOT", "PROJECTS", "HOME"]) restore(name, saved[name]);
  });

  test("splits $WT_ALL_ROOT on colons the way $PATH is written", () => {
    process.env.WT_ALL_ROOT = "/a:/b::/c";
    expect(roots()).toEqual(["/a", "/b", "/c"]);
  });

  test("falls back to $PROJECTS", () => {
    process.env.WT_ALL_ROOT = "";
    process.env.PROJECTS = "/work";
    expect(roots()).toEqual(["/work"]);
    expect(projectsRoot()).toBe("/work");
  });

  test("falls back to src under the home directory", () => {
    process.env.WT_ALL_ROOT = "";
    process.env.PROJECTS = "";
    process.env.HOME = "/home/someone";
    expect(roots()).toEqual(["/home/someone/src"]);
  });
});

describe("jobs", () => {
  const saved = process.env.WT_ALL_JOBS;

  afterEach(() => {
    restore("WT_ALL_JOBS", saved);
  });

  test("takes a positive count from $WT_ALL_JOBS", () => {
    process.env.WT_ALL_JOBS = "3";
    expect(jobs()).toBe(3);
  });

  // Passed to `xargs -P`, zero meant one process per repo. A stray export is a
  // likelier source of it than a request for unbounded concurrency.
  test.each([
    ["", 8],
    ["0", 8],
    ["-4", 8],
    ["many", 8],
  ])("falls back to eight for %p", (value, expected) => {
    process.env.WT_ALL_JOBS = value;
    expect(jobs()).toBe(expected);
  });
});

describe("discover", () => {
  function tree(...paths: string[]): void {
    for (const path of paths) mkdirSync(join(root, path), { recursive: true });
  }

  test("finds a repo by the .git directory it holds", () => {
    tree("one/.git", "nested/two/.git");
    expect(discover([root])).toEqual([join(root, "nested", "two"), join(root, "one")]);
  });

  // A linked worktree carries a .git file pointing back at its main worktree.
  // Pruning the main worktree covers it, and visiting it separately would run
  // the command against the same repository twice.
  test("passes over a worktree whose .git is a file", () => {
    tree("main/.git");
    mkdirSync(join(root, "linked"));
    writeFileSync(join(root, "linked", ".git"), "gitdir: /elsewhere\n");
    expect(discover([root])).toEqual([join(root, "main")]);
  });

  test("does not descend into a dependency tree", () => {
    tree("app/node_modules/dep/.git", "app/vendor/dep/.git", "app/.git");
    expect(discover([root])).toEqual([join(root, "app")]);
  });

  test("stops at four levels down", () => {
    tree("a/b/c/.git", "a/b/c/d/.git");
    expect(discover([root])).toEqual([join(root, "a", "b", "c")]);
  });

  test("reports a repo under overlapping roots once", () => {
    tree("group/one/.git");
    expect(discover([root, join(root, "group")])).toEqual([join(root, "group", "one")]);
  });

  test("skips a root that is not there", () => {
    tree("one/.git");
    expect(discover([join(sandbox, "absent"), root])).toEqual([join(root, "one")]);
  });
});

describe("display", () => {
  test("cuts the projects root off the front", () => {
    expect(display("/home/me/src/group/repo", "/home/me/src/")).toBe("group/repo");
  });

  test("leaves a repo outside that root spelled out in full", () => {
    expect(display("/opt/checkout", "/home/me/src/")).toBe("/opt/checkout");
  });
});

describe("rowsFor", () => {
  function result(stdout: string): Result {
    return { display: "repo", stdout, stderr: "", ok: true };
  }

  test("keys every line of a repo's output to that repo", () => {
    expect(rowsFor(result("first\nsecond\n"))).toEqual([
      ["repo", "first"],
      ["repo", "second"],
    ]);
  });

  test("splits tab-separated fields into their own columns", () => {
    expect(rowsFor(result("2\t3\n"))).toEqual([["repo", "2", "3"]]);
  });

  test("drops the blank line a command uses to separate records", () => {
    expect(rowsFor(result("first\n\nsecond\n"))).toEqual([
      ["repo", "first"],
      ["repo", "second"],
    ]);
  });

  test("gives a repo that printed nothing no rows", () => {
    expect(rowsFor(result(""))).toEqual([]);
  });
});

describe("countsIn", () => {
  test("reads the pair prune reports", () => {
    expect(countsIn("2\t3\n")).toEqual([2, 3]);
  });

  test.each([["one line"], ["2\t3\nand more"], ["2 3"], ["2\tthree"], [""]])(
    "declines to total %p",
    (output) => {
      expect(countsIn(output)).toBeUndefined();
    },
  );
});

describe("pruneTable", () => {
  test("heads the columns and puts the biggest cleanup on top", () => {
    const table = pruneTable([
      ["small", "1", "9"],
      ["big", "4", "0"],
      ["middle", "4", "2"],
    ]);
    expect(table).toEqual([
      "REPO    WORKTREES  BRANCHES",
      "middle  4          2",
      "big     4          0",
      "small   1          9",
    ]);
  });
});

describe("summarize", () => {
  test("reports what was scanned and what answered", () => {
    expect(
      summarize({ scanned: 12, active: 2, failed: 0, worktrees: 0, branches: 0 }),
    ).toBe("12 scanned · 2 with output");
  });

  test("names the failures and the totals when there are any", () => {
    expect(
      summarize({ scanned: 12, active: 2, failed: 1, worktrees: 5, branches: 3 }),
    ).toBe("12 scanned · 2 with output · 1 failed · 5 worktrees, 3 branches");
  });

  test("totals a run that removed branches and no worktrees", () => {
    expect(summarize({ scanned: 1, active: 1, failed: 0, worktrees: 0, branches: 2 })).toEndWith(
      "· 0 worktrees, 2 branches",
    );
  });
});

describe("failureBlock", () => {
  function failure(stderr: string): Result {
    return { display: "repo", stdout: "", stderr, ok: false };
  }

  test("indents the diagnostics under the repo that produced them", () => {
    expect(failureBlock(failure("boom\nagain\n"))).toBe("repo:\n  boom\n  again");
  });

  test("keeps the last twenty lines of a repo that failed by printing", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const block = failureBlock(failure(`${lines.join("\n")}\n`)) ?? "";
    expect(block.split("\n")).toHaveLength(21);
    expect(block).toEndWith("  line 29");
    expect(block).not.toInclude("line 9\n");
  });

  test("has nothing to show for a repo that failed silently", () => {
    expect(failureBlock(failure("\n\n"))).toBeUndefined();
  });
});

describe("frame", () => {
  test("cycles through the spinner", () => {
    expect(frame(1)).toBe("⠙");
    expect(frame(11)).toBe(frame(1));
  });
});

test("prints the usage on --help", () => {
  const outcome = run(["--help"]);
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toStartWith("Usage: wt all <cmd> [args]");
  expect(log("WT_LOG")).toEqual([]);
});

// The shell ran a bare `wt` in every repo, so worktrunk's usage text came back
// as a finding from each one.
test("refuses to fan out with no command", () => {
  repo("one");
  const outcome = run([]);
  expect(outcome.status).toBe(2);
  expect(outcome.stderr).toStartWith("wt all: no command given\n");
  expect(log("WT_LOG")).toEqual([]);
});

test.each(["wt", "gum"])("names %p once instead of failing in every repo", (tool) => {
  repo("one");
  repo("two");
  rmSync(join(stubs, tool));

  const outcome = run(["prune"]);
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toBe(`wt all: ${tool} is required\n`);
  expect(log("WT_LOG")).toEqual([]);
});

test("runs the command in every repo it found", () => {
  repo("one");
  repo("two");

  const outcome = run(["prune-audit", "--json"]);
  expect(outcome.status).toBe(0);
  expect(log("WT_LOG")).toEqual([
    `-C ${join(root, "one")} prune-audit --json`,
    `-C ${join(root, "two")} prune-audit --json`,
  ]);
});

// $WT_ALL is how a wrapped command knows it is one of many and switches to the
// one line this script can put in a table.
test("marks the fan-out in the environment each repo runs under", () => {
  repo("one");

  run(["prune"]);
  expect(log("WT_ENV_LOG")).toEqual(["one WT_ALL=1"]);
});

test("leaves out a repo that had nothing to say", () => {
  repo("quiet");
  repo("loud", { stdout: "something\n" });

  const outcome = run(["prune-audit"]);
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toBe("loud  something\n\n");
  expect(log("GUM_LOG")).toEqual(["log --level info 2 scanned · 1 with output"]);
});

test("aligns the columns a command's own tabs asked for", () => {
  repo("short", { stdout: "a\tlonger value\n" });
  repo("longer-name", { stdout: "bb\tb\n" });

  expect(run(["prune-audit"]).stdout).toBe(
    ["longer-name  bb  b", "short        a   longer value", "", ""].join("\n"),
  );
});

test("heads and sorts the table for prune", () => {
  repo("small", { stdout: "1\t1\n" });
  repo("big", { stdout: "4\t0\n" });

  const outcome = run(["prune"]);
  expect(outcome.stdout).toBe(
    ["REPO   WORKTREES  BRANCHES", "big    4          0", "small  1          1", "", ""].join("\n"),
  );
  expect(log("GUM_LOG")).toEqual([
    "log --level info 2 scanned · 2 with output · 5 worktrees, 1 branches",
  ]);
});

// A caller parsing the fields cannot split an aligned table back apart, since
// the padding is indistinguishable from a cell that holds spaces.
test("prints unpadded rows and no spacer under $WT_ALL_RAW", () => {
  repo("one", { stdout: "4\t0\n" });

  const outcome = run(["prune"], { WT_ALL_RAW: "1" });
  expect(outcome.stdout).toBe("one\t4\t0\n");
});

test("reports a repo whose command failed instead of its half-finished output", () => {
  repo("broken", { stdout: "partial\n", stderr: "fatal: bad object\n", status: 1 });
  repo("fine", { stdout: "clean\n" });

  const outcome = run(["prune-audit"]);
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toBe("fine  clean\n\n");
  expect(outcome.stderr).toBe("broken:\n  fatal: bad object\n");
  expect(log("GUM_LOG")).toEqual([
    "log --level info 2 scanned · 1 with output · 1 failed",
    "log --level warn failed: broken",
  ]);
});

test("names a repo that failed without saying why", () => {
  repo("broken", { status: 2 });

  const outcome = run(["prune-audit"]);
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toBe("");
  expect(log("GUM_LOG")).toEqual([
    "log --level info 1 scanned · 0 with output · 1 failed",
    "log --level warn failed: broken",
  ]);
});

test("says so when the roots hold no repos at all", () => {
  const outcome = run(["prune"]);
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toBe("\n");
  expect(log("GUM_LOG")).toEqual(["log --level info 0 scanned · 0 with output"]);
});

test("walks the roots $WT_ALL_ROOT names instead of the projects directory", () => {
  repo("ignored");
  const elsewhere = join(sandbox, "elsewhere");
  mkdirSync(join(elsewhere, "picked", ".git"), { recursive: true });

  run(["prune"], { WT_ALL_ROOT: elsewhere });
  expect(log("WT_LOG")).toEqual([`-C ${join(elsewhere, "picked")} prune`]);
});
