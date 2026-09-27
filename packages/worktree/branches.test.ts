import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { decideBranch, EXPIRY, pruneBranches, readBranches, type BranchReport } from "#worktree/branches";

// A real repo, not a stub: this pass reasons about actual refs, reflogs and
// remote-tracking state, which a stubbed `git` cannot stand in for. Isolated
// from the machine's own git identity and any global config, so the suite
// passes wherever it runs.
let box: Sandbox;
let repo: string;
let remote: string;
let cwd: string;

const IDENTITY = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

// Old enough to clear the default 1d floor without every fixture branch
// naming its own date.
const OLD = "2020-01-01T00:00:00Z";

let fileCount = 0;

beforeEach(() => {
  box = sandbox("branches");
  repo = box.mkdir("repo");
  remote = box.mkdir("remote.git");
  fileCount = 0;

  for (const [key, value] of Object.entries(IDENTITY)) process.env[key] = value;
  delete process.env.WT_PRUNE_MIN_AGE;

  git(["init", "-q", "--bare"], remote);
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", remote]);
  commit("init", OLD);
  git(["push", "-q", "origin", "main"]);

  cwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(cwd);
  for (const key of Object.keys(IDENTITY)) delete process.env[key];
  delete process.env.WT_PRUNE_MIN_AGE;
  box.remove();
});

function git(args: string[], dir = repo, extraEnv: Record<string, string> = {}): string {
  const run = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdin: "ignore",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().replace(/\n+$/, "");
}

function exists(ref: string): boolean {
  const run = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--verify", "-q", ref],
    cwd: repo,
    env: process.env,
    stdin: "ignore",
  });
  return run.exitCode === 0;
}

// Dated so the fixtures control staleness without waiting on a real clock.
function commit(message: string, date: string): void {
  fileCount += 1;
  const name = `file-${fileCount}`;
  box.write(`repo/${name}`, message);
  git(["add", name]);
  git(["commit", "-q", "-m", message], repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

// A ref update dated OLD, so the branch's own reflog clears the floor the
// same way its commits do.
function aged(args: string[]): string {
  return git(args, repo, { GIT_COMMITTER_DATE: OLD });
}

function tip(branch = "HEAD"): string {
  return git(["rev-parse", branch]);
}

function report(): BranchReport {
  return { branches: 0, reasons: [] };
}

describe("decideBranch", () => {
  test("a fully backed-up tip is deleted", () => {
    expect(decideBranch(true)).toEqual({ action: "delete", reason: "backed up" });
  });

  test("a tip with commits nowhere else is archived", () => {
    expect(decideBranch(false)).toEqual({ action: "archive", reason: "local-only" });
  });
});

describe("readBranches", () => {
  test("keeps only worktree-less, non-default branches", () => {
    const captured = ["main\tabc\t", "feature\tdef\t", "checked-out\tghi\t/repo/wt"].join("\n");
    expect(readBranches(captured, "main")).toEqual([{ name: "feature", tip: "def" }]);
  });

  test("reads nothing from an empty listing", () => {
    expect(readBranches("", "main")).toEqual([]);
  });
});

describe("pruneBranches (sandboxed)", () => {
  test("leaves the checked-out and default branches alone", () => {
    git(["worktree", "add", box.path("wt-checked-out"), "-b", "checked-out"]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(0);
    expect(exists("refs/heads/main")).toBe(true);
    expect(exists("refs/heads/checked-out")).toBe(true);
  });

  test("a branch whose tip is already on main is deleted with no archive ref", () => {
    aged(["branch", "same-as-main", "main"]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(exists("refs/heads/same-as-main")).toBe(false);
    expect(exists("refs/archive/same-as-main")).toBe(false);
  });

  test("a branch pushed to its own remote is deleted", () => {
    aged(["checkout", "-q", "-b", "pushed", "main"]);
    commit("pushed work", OLD);
    git(["push", "-q", "origin", "pushed"]);
    git(["checkout", "-q", "main"]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(exists("refs/heads/pushed")).toBe(false);
    expect(exists("refs/archive/pushed")).toBe(false);
  });

  test("a branch with local-only commits is archived at its old tip", () => {
    aged(["checkout", "-q", "-b", "local-only", "main"]);
    commit("local work", OLD);
    const branchTip = tip();
    git(["checkout", "-q", "main"]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(exists("refs/heads/local-only")).toBe(false);
    expect(git(["rev-parse", "refs/archive/local-only"])).toBe(branchTip);
  });

  test("an archive-name collision is suffixed rather than overwritten", () => {
    aged(["checkout", "-q", "-b", "collide", "main"]);
    commit("local work", OLD);
    const branchTip = tip();
    git(["checkout", "-q", "main"]);

    const unrelated = tip("main");
    git(["update-ref", "--create-reflog", "refs/archive/collide", unrelated]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(git(["rev-parse", "refs/archive/collide"])).toBe(unrelated);
    const short = git(["rev-parse", "--short", branchTip]);
    expect(git(["rev-parse", `refs/archive/collide-${short}`])).toBe(branchTip);
  });

  // What `wt switch --create` leaves between creating the branch and adding
  // its worktree: a new ref on a tip whose commit date is long past.
  test("a branch created just now on an old tip is left alone", () => {
    git(["branch", "fresh", "main"]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(0);
    expect(exists("refs/heads/fresh")).toBe(true);
  });

  test("an unparseable floor leaves every branch alone", () => {
    aged(["branch", "same-as-main", "main"]);

    const rep = report();
    pruneBranches("main", "soon", false, false, rep);

    expect(rep.branches).toBe(0);
    expect(exists("refs/heads/same-as-main")).toBe(true);
  });

  test("dry run changes no refs but counts what it would do", () => {
    aged(["checkout", "-q", "-b", "local-only", "main"]);
    commit("local work", OLD);
    git(["checkout", "-q", "main"]);
    aged(["branch", "same-as-main", "main"]);

    const rep = report();
    pruneBranches("main", "1d", true, true, rep);

    expect(rep.branches).toBe(2);
    expect(exists("refs/heads/local-only")).toBe(true);
    expect(exists("refs/heads/same-as-main")).toBe(true);
    expect(exists("refs/archive/local-only")).toBe(false);
    expect(rep.reasons).toContainEqual(["-", "local-only", "-", "archive", "local-only"]);
    expect(rep.reasons).toContainEqual(["-", "same-as-main", "-", "delete", "backed up"]);
  });
});

describe("archive expiry", () => {
  function archiveWithReflogAt(name: string, epochSeconds: number): void {
    const at = new Date(epochSeconds * 1000).toISOString();
    git(["update-ref", "--create-reflog", `refs/archive/${name}`, tip("main")], repo, {
      GIT_COMMITTER_DATE: at,
    });
  }

  test("an archive ref past 90 days expires", () => {
    const past = Math.floor(Date.now() / 1000) - EXPIRY - 86400;
    archiveWithReflogAt("old", past);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(exists("refs/archive/old")).toBe(false);
  });

  test("an archive ref within 90 days is left alone", () => {
    const recent = Math.floor(Date.now() / 1000) - 86400;
    archiveWithReflogAt("recent", recent);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(0);
    expect(exists("refs/archive/recent")).toBe(true);
  });

  test("re-archiving a tip an expired archive already holds restarts its clock", () => {
    const past = Math.floor(Date.now() / 1000) - EXPIRY - 86400;
    aged(["checkout", "-q", "-b", "refreshed", "main"]);
    commit("local work", OLD);
    const branchTip = tip();
    git(["checkout", "-q", "main"]);
    git(["update-ref", "--create-reflog", "refs/archive/refreshed", branchTip], repo, {
      GIT_COMMITTER_DATE: new Date(past * 1000).toISOString(),
    });

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(1);
    expect(exists("refs/heads/refreshed")).toBe(false);
    expect(git(["rev-parse", "refs/archive/refreshed"])).toBe(branchTip);
  });

  test("an archive ref with no reflog is left alone however old its commit is", () => {
    git(["update-ref", "refs/archive/no-reflog", tip("main")]);

    const rep = report();
    pruneBranches("main", "1d", false, false, rep);

    expect(rep.branches).toBe(0);
    expect(exists("refs/archive/no-reflog")).toBe(true);
  });
});
