import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  type Facts,
  type Metadata,
  parseWorktrees,
  readMetadata,
  sweepRoots,
} from "./wt-orphans";

const SCRIPT = join(import.meta.dir, "wt-orphans");

// No guard at all, so a fixture created seconds ago is old enough to remove.
// The guard itself gets its own case against the default.
const NO_FLOOR = "0h";

describe("parseWorktrees", () => {
  test("reads the paths in order, main worktree first", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/feature",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktrees(porcelain)).toEqual(["/repo", "/repo/.worktrees/feature"]);
  });

  test("reads output from a directory that is not a repo as no worktrees", () => {
    expect(parseWorktrees("")).toEqual([]);
  });
});

describe("sweepRoots", () => {
  test("always sweeps the repo's own .worktrees, registered or not", () => {
    expect(sweepRoots("/src/repo", ["/src/repo"])).toEqual(["/src/repo/.worktrees"]);
  });

  test.each([
    { name: "worktrunk's tree", worktree: "/src/.worktrees/owner/repo/feature" },
    { name: "herdr's tree", worktree: "/home/.herdr/worktrees/repo/feature" },
    { name: "the repo's own tree", worktree: "/src/repo/.worktrees/agent-1" },
  ])("sweeps the parent of a worktree inside $name", ({ worktree }) => {
    expect(sweepRoots("/src/repo", ["/src/repo", worktree])).toContain(
      worktree.slice(0, worktree.lastIndexOf("/")),
    );
  });

  // The whole safety argument for treating an unregistered sibling as garbage
  // is that the directory exists to hold worktrees. `git worktree add ../beside`
  // puts one in a directory full of unrelated projects, and sweeping there would
  // read every one of them as an orphan.
  test("refuses a worktree parent that is not a directory of worktrees", () => {
    expect(sweepRoots("/src/repo", ["/src/repo", "/src/beside"])).toEqual([
      "/src/repo/.worktrees",
    ]);
  });

  test("reports each root once when several worktrees share one", () => {
    const roots = sweepRoots("/src/repo", [
      "/src/repo",
      "/src/.worktrees/owner/repo/one",
      "/src/.worktrees/owner/repo/two",
    ]);
    expect(roots).toEqual(["/src/repo/.worktrees", "/src/.worktrees/owner/repo"]);
  });
});

describe("classify", () => {
  function facts(over: Partial<Facts> = {}): Facts {
    return { registered: false, metadata: "none", minAge: 3600, age: () => 86400, ...over };
  }

  test.each<{ name: string; over: Partial<Facts>; expected: string | undefined }>([
    {
      name: "names a directory with no git metadata",
      over: { metadata: "none" },
      expected: "no git metadata",
    },
    {
      name: "names a directory whose git metadata is gone",
      over: { metadata: "dangling" },
      expected: "git metadata gone",
    },
    {
      name: "spares a registered worktree",
      over: { registered: true },
      expected: undefined,
    },
    {
      name: "spares anything git can still resolve",
      over: { metadata: "present" },
      expected: undefined,
    },
    {
      name: "spares a worktree stranded by another repo",
      over: { metadata: "foreign" },
      expected: undefined,
    },
    {
      name: "spares a directory younger than the floor",
      over: { age: () => 60 },
      expected: undefined,
    },
    // The opposite reading to wt prune-audit's, where an unreadable clock must
    // not hide drift. Here it must not authorize a removal.
    {
      name: "spares a directory whose age will not read",
      over: { age: () => undefined },
      expected: undefined,
    },
  ])("$name", ({ over, expected }) => {
    expect(classify(facts(over))).toBe(expected);
  });

  // The age lookup costs a stat per candidate, and most candidates are
  // registered worktrees that the first check already answered for.
  test("does not read the clock for a directory it has already spared", () => {
    let read = 0;
    classify(facts({ registered: true, age: () => (read += 1) }));
    expect(read).toBe(0);
  });
});

describe("readMetadata", () => {
  let box: string;
  let common: string;

  beforeEach(() => {
    box = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-metadata-")));
    common = join(box, "repo", ".git");
    mkdirSync(join(common, "worktrees"), { recursive: true });
  });

  afterEach(() => rmSync(box, { recursive: true, force: true }));

  function dir(name: string, dotGit?: string): string {
    const path = join(box, name);
    mkdirSync(path, { recursive: true });
    if (dotGit !== undefined) writeFileSync(join(path, ".git"), dotGit);
    return path;
  }

  test.each<{ name: string; make: () => string; expected: Metadata }>([
    {
      name: "reads a directory with no .git as having none",
      make: () => dir("husk"),
      expected: "none",
    },
    {
      name: "reads a .git file pointing into this repo at nothing as dangling",
      make: () => dir("orphan", `gitdir: ${join(common, "worktrees", "gone")}\n`),
      expected: "dangling",
    },
    {
      name: "reads a .git file pointing at a repo that is not this one as foreign",
      make: () => dir("stranded", "gitdir: /nowhere/other/.git/worktrees/x\n"),
      expected: "foreign",
    },
    {
      name: "reads a .git file git can still resolve as present",
      make: () => dir("live", `gitdir: ${common}\n`),
      expected: "present",
    },
    {
      name: "reads a .git directory as present",
      make: () => {
        const path = dir("clone");
        mkdirSync(join(path, ".git"));
        return path;
      },
      expected: "present",
    },
    // A .git file we could not parse says nothing about whether git could.
    {
      name: "reads a .git file it cannot parse as present",
      make: () => dir("garbled", "this is not a gitdir pointer\n"),
      expected: "present",
    },
    {
      name: "resolves a relative gitdir against the directory holding it",
      make: () => dir("relative", "gitdir: ../repo/.git/worktrees/gone\n"),
      expected: "dangling",
    },
  ])("$name", ({ make, expected }) => {
    expect(readMetadata(make(), common)).toBe(expected);
  });
});

describe("sweeping a repo", () => {
  let box: string;
  let repo: string;
  let root: string;
  let live: string;

  beforeEach(() => {
    // git reports resolved paths, and on macOS /tmp is a symlink into /private.
    box = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-")));
    repo = join(box, "repo");
    root = join(repo, ".worktrees");

    // A runner with no global gitconfig cannot commit without these, and a
    // worktree needs a commit to be added against.
    git(["init", "-q", "-b", "main", repo]);
    git(["-C", repo, "config", "user.email", "spec@example.test"]);
    git(["-C", repo, "config", "user.name", "Spec"]);
    git(["-C", repo, "config", "commit.gpgsign", "false"]);
    git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);

    live = join(root, "registered");
    git(["-C", repo, "worktree", "add", "-q", "-b", "registered", live]);
  });

  afterEach(() => {
    // A case that made a directory unwritable to force a partial removal has to
    // hand it back before the sandbox itself can be cleared.
    chmodSync(box, 0o755);
    for (const path of ["stuck", "stuck/vendored"]) {
      const full = join(root, path);
      if (existsSync(full)) chmodSync(full, 0o755);
    }
    rmSync(box, { recursive: true, force: true });
  });

  function git(args: string[]): void {
    const run = Bun.spawnSync({ cmd: ["git", ...args], env: process.env, stdin: "ignore" });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }

  interface Result {
    status: number;
    rows: string[][];
    stderr: string;
  }

  function sweep(args: string[] = [], env: Record<string, string> = {}): Result {
    const run = Bun.spawnSync({
      cmd: [SCRIPT, ...args],
      cwd: repo,
      // WT_ALL is what the fan-out sets, and it selects the tab-separated rows
      // a caller parses over the table a reader gets.
      env: { ...process.env, WT_PRUNE_MIN_AGE: NO_FLOOR, WT_ALL: "1", ...env },
      stdin: "ignore",
    });
    return {
      status: run.exitCode,
      rows: run.stdout
        .toString()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t")),
      stderr: run.stderr.toString(),
    };
  }

  function husk(name: string, dotGit?: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "leftover"), "x");
    if (dotGit !== undefined) writeFileSync(join(path, ".git"), dotGit);
    return path;
  }

  test("removes a husk that has no git metadata left", () => {
    const orphan = husk("agent-abc");

    expect(sweep().rows).toEqual([["removed", "no git metadata", orphan]]);
    expect(existsSync(orphan)).toBe(false);
  });

  test("removes a husk whose metadata this repo has already dropped", () => {
    const orphan = husk("wf_1", `gitdir: ${join(repo, ".git", "worktrees", "wf_1")}\n`);

    expect(sweep().rows).toEqual([["removed", "git metadata gone", orphan]]);
    expect(existsSync(orphan)).toBe(false);
  });

  test("never touches a registered worktree", () => {
    husk("agent-abc");

    expect(sweep().rows).toEqual([["removed", "no git metadata", join(root, "agent-abc")]]);
    expect(existsSync(join(live, ".git"))).toBe(true);
  });

  // The pruner's own first-day grace, so a worktree still being created cannot
  // be swept out from under whatever is creating it.
  test("leaves a husk younger than the age floor alone", () => {
    const orphan = husk("agent-abc");

    expect(sweep([], { WT_PRUNE_MIN_AGE: "1d" }).rows).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });

  test("reports a directory stranded by another repo without removing it", () => {
    const stranded = husk("moved", "gitdir: /nowhere/other/.git/worktrees/moved\n");

    expect(sweep().rows).toEqual([["kept", "stranded by another repo", stranded]]);
    expect(existsSync(stranded)).toBe(true);
  });

  // A worktree root collects tool state beside the checkouts. Claude Code keeps
  // its own .claude/ in the one it creates agent worktrees in.
  test("leaves hidden entries in the root alone", () => {
    mkdirSync(join(root, ".claude", "state"), { recursive: true });

    expect(sweep().rows).toEqual([]);
    expect(existsSync(join(root, ".claude", "state"))).toBe(true);
  });

  test("leaves a clone standing in the root alone", () => {
    const clone = join(root, "clone");
    git(["init", "-q", "-b", "main", clone]);

    expect(sweep().rows).toEqual([]);
    expect(existsSync(join(clone, ".git"))).toBe(true);
  });

  test("does not follow a symlink into the root", () => {
    const orphan = husk("agent-abc");
    Bun.spawnSync({ cmd: ["ln", "-s", orphan, join(root, "link")], env: process.env });

    expect(sweep().rows).toEqual([["removed", "no git metadata", orphan]]);
  });

  test("names what it would remove and removes nothing under --dry-run", () => {
    const orphan = husk("agent-abc");

    expect(sweep(["--dry-run"]).rows).toEqual([["would remove", "no git metadata", orphan]]);
    expect(existsSync(orphan)).toBe(true);
  });

  // The husks exist because a removal already died on a file it could not
  // unlink, so the sweep meets the same wall and has to report it rather than
  // fail the run or retry forever.
  test("reports a removal that could not finish and carries on to the next", () => {
    const stuck = husk("stuck");
    const vendored = join(stuck, "vendored");
    mkdirSync(vendored);
    writeFileSync(join(vendored, "protected"), "x");
    chmodSync(vendored, 0o555);
    const clearable = husk("zzz-clearable");

    const result = sweep();
    expect(result.status).toBe(0);
    // The errno is whatever the platform raised for the file it could not
    // unlink, which is not the same on macOS and Linux.
    expect(result.rows.map((row) => [row[0], row[2]])).toEqual([
      ["failed", stuck],
      ["removed", clearable],
    ]);
    expect(result.rows[0][1]).toMatch(/^E[A-Z]+$/);
    expect(existsSync(stuck)).toBe(true);
    expect(existsSync(clearable)).toBe(false);
  });

  test("sweeps a worktrunk root outside the repo", () => {
    const outside = join(box, ".worktrees", "owner", "repo");
    mkdirSync(outside, { recursive: true });
    git(["-C", repo, "worktree", "add", "-q", "-b", "elsewhere", join(outside, "elsewhere")]);
    const orphan = join(outside, "gone");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "leftover"), "x");

    expect(sweep().rows).toEqual([["removed", "no git metadata", orphan]]);
  });

  test("refuses a duration it cannot read rather than sweeping against a guess", () => {
    const orphan = husk("agent-abc");

    const result = sweep([], { WT_PRUNE_MIN_AGE: "30min" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WT_PRUNE_MIN_AGE=30min");
    expect(existsSync(orphan)).toBe(true);
  });

  test("sweeps nothing outside a git repo", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-bare-")));
    const run = Bun.spawnSync({
      cmd: [SCRIPT],
      cwd: outside,
      env: { ...process.env, WT_PRUNE_MIN_AGE: NO_FLOOR, WT_ALL: "1" },
      stdin: "ignore",
    });
    rmSync(outside, { recursive: true, force: true });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
  });

  test("aligns the rows into a table when nothing is fanning it out", () => {
    husk("agent-abc");

    const run = Bun.spawnSync({
      cmd: [SCRIPT, "--dry-run"],
      cwd: repo,
      env: { ...process.env, WT_PRUNE_MIN_AGE: NO_FLOOR, WT_ALL: "" },
      stdin: "ignore",
    });
    expect(run.stdout.toString()).toContain("VERDICT");
  });
});
