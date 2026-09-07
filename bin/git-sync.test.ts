import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { must, repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "#harness";

// bin/git-sync is the command form of scripts/shell/git-sync.sh, for the
// TypeScript callers that cannot source it. These cover the boundary: the
// three status codes a caller reads instead of $GIT_SYNC_*, and the
// environment git_https_env would have exported, printed instead so the
// caller can scope it to the children that need it.

const script = join(repoRoot, "bin", "git-sync");

let box: Sandbox;
let repo: string;
let origin: string;

beforeEach(() => {
  box = sandbox("git-sync-bin");
  stubGum(box);
  repo = box.path("repo");
  origin = box.path("origin");

  // -b main, because the fixture would otherwise inherit init.defaultBranch
  // from whoever runs it: on a machine that leaves it at master, the bare
  // repo's HEAD names a branch nothing ever pushes, the clone below checks
  // out nothing, and the push has no local main to send.
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "init", "-q", "-b", "main", repo]);
  must(["git", "-C", repo, "config", "user.email", "spec@example.com"]);
  must(["git", "-C", repo, "config", "user.name", "Spec"]);
  must(["git", "-C", repo, "config", "commit.gpgsign", "false"]);
  must(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "first"]);
  must(["git", "-C", repo, "remote", "add", "origin", origin]);
  must(["git", "-C", repo, "push", "-q", "origin", "main"]);
  must(["git", "-C", repo, "branch", "-q", "--set-upstream-to", "origin/main", "main"]);
});

afterEach(() => {
  box.remove();
});

function runScript(args: string[]): Run {
  return run([script, ...args], { path: [box.bin] });
}

// env -u, because the sandbox this suite can run under sets its own
// GIT_CONFIG entries, and https-env reports whatever it is appending to.
function runGitSync(args: string[]): Run {
  return run([script, ...args], { path: [box.bin], env: { GIT_CONFIG_COUNT: undefined } });
}

describe("bin/git-sync", () => {
  describe("sync", () => {
    // 2 rather than 0, because a caller has to tell "nothing to do" from
    // "updated" to decide whether its post-update side effects should run.
    test("reports an unmoved clone as current", () => {
      const r = runGitSync(["sync", repo, "main"]);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toBe("");
    });

    test("prints the new short rev when the clone moves", () => {
      const scratch = box.path("scratch");
      must(["git", "clone", "-q", "--branch", "main", origin, scratch]);
      must(["git", "-C", scratch, "config", "user.email", "spec@example.com"]);
      must(["git", "-C", scratch, "config", "user.name", "Spec"]);
      must(["git", "-C", scratch, "config", "commit.gpgsign", "false"]);
      must(["git", "-C", scratch, "commit", "-q", "--allow-empty", "-m", "second"]);
      must(["git", "-C", scratch, "push", "-q", "origin", "HEAD:main"]);

      const r = runScript(["sync", repo, "main"]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(must(["git", "-C", origin, "rev-parse", "--short", "main"]).trim());
      expect(r.stderr).not.toBe("");
    });

    test("fails on a directory that is not a repository", () => {
      const r = runGitSync(["sync", box.dir, "main"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not a git repository");
    });

    // The guard that keeps an unattended sync from discarding work in progress.
    test("fails on a dirty tree", () => {
      box.write("repo/file", "change\n");
      must(["git", "-C", repo, "add", "file"]);
      const r = runScript(["sync", repo, "main"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("local changes");
    });
  });

  describe("https-env", () => {
    test("prints both SSH prefixes as insteadOf rules", () => {
      const r = runGitSync(["https-env"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf");
      expect(r.stdout).toContain("GIT_CONFIG_VALUE_0=git@github.com:");
      expect(r.stdout).toContain("GIT_CONFIG_VALUE_1=ssh://git@github.com/");
      expect(r.stdout).toContain("GIT_CONFIG_COUNT=2");
    });

    // A machine-local GIT_CONFIG entry has to survive, so the rules are
    // appended at the next free index rather than written over index 0.
    test("appends to entries already in the environment", () => {
      const r = run([script, "https-env"], {
        path: [box.bin],
        env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/somewhere" },
      });
      expect(r.stdout).toContain("GIT_CONFIG_KEY_0=safe.directory");
      expect(r.stdout).toContain("GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf");
      expect(r.stdout).toContain("GIT_CONFIG_COUNT=3");
    });
  });

  describe("default-branch", () => {
    // The fixture is built by hand and has no refs/remotes/origin/HEAD, which
    // is the path that takes the set-head retry. That retry announces itself on
    // stdout, so before it was silenced this answered with its own confirmation
    // line above the branch name, and every caller reads this through command
    // substitution.
    test("names the branch a sync would target", () => {
      const r = runGitSync(["default-branch", repo]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("main");
    });
  });

  test("rejects an unknown subcommand", () => {
    const r = runGitSync(["frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});
