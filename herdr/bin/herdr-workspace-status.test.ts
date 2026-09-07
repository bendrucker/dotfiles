import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists,
  must,
  quote,
  resolveOnPath,
  run,
  sandbox,
  type Sandbox,
} from "../../scripts/lib/shell-fixtures.ts";

const script = join(import.meta.dir, "herdr-workspace-status");
const config = join(import.meta.dir, "..", "config.toml");

// A repo with an origin and a worktree on a topic branch one commit past it,
// with an edited file. The stub herdr lists that worktree and records what
// gets reported for it. Neither forge stub is on PATH until a case puts one
// there, and the origin URL is what picks between them.
function setupRepo(box: Sandbox): string {
  const origin = box.path("origin");
  const repo = box.path("repo");
  must(["git", "init", "-q", "-b", "main", origin]);
  must([
    "git",
    "-C",
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  ]);
  must(["git", "clone", "-q", origin, repo]);
  must(["git", "-C", repo, "switch", "-q", "-c", "topic"]);
  box.write("repo/file", "one\n");
  must(["git", "-C", repo, "add", "file"]);
  must([
    "git",
    "-C",
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "topic",
  ]);
  box.write("repo/file", "two\n");

  box.stub(
    "herdr",
    [
      'case "$1 $2" in',
      `  "workspace list") printf '%s' '{"result":{"workspaces":[{"workspace_id":"w1","label":"my-topic",` +
        `"worktree":{"checkout_path":"${repo}"}}]}}' ;;`,
      `  "workspace report-metadata") shift 2; printf '%s\\n' "$@" > ${quote(box.path("reported"))} ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );

  return repo;
}

function stubGh(box: Sandbox, repo: string): void {
  must(["git", "-C", repo, "remote", "set-url", "origin", "git@github.com:me/repo.git"]);
  box.stub(
    "gh",
    [
      'case "$1 $2" in',
      '  "pr list") echo \'[{"number":7,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE",' +
        '"baseRefName":"main","headRefOid":"0000000","updatedAt":"2026-01-01T00:00:00Z",' +
        '"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]},{"number":3,' +
        '"state":"CLOSED","isDraft":false,"baseRefName":"main","updatedAt":"2025-01-01T00:00:00Z",' +
        '"statusCheckRollup":[]}]\' ;;',
      '  "api repos/{owner}/{repo}/pulls/7") echo "" ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
}

function stubGlab(box: Sandbox, repo: string): void {
  must(["git", "-C", repo, "remote", "set-url", "origin", "git@gitlab.example.com:me/repo.git"]);
  box.stub(
    "glab",
    [
      'case "$1 $2" in',
      '  "mr list") echo \'[{"iid":9,"state":"opened","draft":false,"has_conflicts":false,' +
        '"target_branch":"other","sha":"0000000","updated_at":"2026-01-01T00:00:00Z"}]\' ;;',
      '  "api projects/:id/merge_requests/9") echo \'{"iid":9,"head_pipeline":{"status":"success"}}\' ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
}

// The herdr server runs the script from `/bin/sh -lc` with no locale set,
// where a glob `?` matches one byte and a glyph is three.
function reportWorkspace(box: Sandbox) {
  return run([script], { path: [box.bin], env: { LC_ALL: "C" } });
}

let box: Sandbox;

beforeEach(() => {
  box = sandbox("herdr-workspace-status");
});

afterEach(() => {
  box.remove();
});

describe("herdr-workspace-status", () => {
  test("is executable", () => {
    expect(run(["test", "-x", script]).status).toBe(0);
  });

  test.skipIf(!commandExists("shellcheck"))("passes shellcheck", () => {
    expect(run(["shellcheck", script]).status).toBe(0);
  });

  test("is reachable on PATH from a login shell", () => {
    expect(resolveOnPath("herdr", "herdr-workspace-status")).toBe(realpathSync(script));
  });

  test("runs on the tab bar interval by the name PATH exports", () => {
    expect(readFileSync(config, "utf8")).toContain('command = "herdr-workspace-status"');
  });

  test("refuses without herdr on PATH", () => {
    const r = run([script], { onlyPath: ["/usr/bin", "/bin"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not on PATH");
  });

  test("reports the branch and a red cluster for a GitHub branch with a failing pull request", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("w1");
    expect(reported).toContain("--source");
    expect(reported).toContain("branch=topic");
    expect(reported).toContain("status_red= ");
    expect(reported).not.toContain("status_green=");
    expect(reported).toContain("--clear-token");
  });

  test("reports a green stacked cluster for a GitLab branch whose merge request passes", () => {
    const repo = setupRepo(box);
    stubGlab(box, repo);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_green= ");
    expect(reported).not.toContain("status_red=");
  });

  test("shows the stack glyph in the worst checks color for a branch with two open pull requests", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    const twoJson = box.write(
      "two.json",
      [
        '[{"number":7,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","baseRefName":"main",' +
          '"headRefOid":"0000000","updatedAt":"2026-01-01T00:00:00Z",' +
          '"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]},',
        ' {"number":10,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","baseRefName":"other",' +
          '"headRefOid":"0000000","updatedAt":"2026-01-02T00:00:00Z",' +
          '"statusCheckRollup":[{"status":"IN_PROGRESS"}]}]',
      ].join("\n"),
    );
    box.stub(
      "gh",
      [`[ "$1 $2" = "pr list" ] && exec cat ${quote(twoJson)}`, '[ "$1" = api ] && exit 0', "exit 1"].join("\n"),
    );
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_yellow= ");
    expect(reported).not.toContain("");
  });

  test("shows only the dirty glyph when the branch is both dirty and unpushed", () => {
    setupRepo(box);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_yellow=");
    expect(reported).not.toContain("");
  });

  test("turns the row yellow for unpushed commits on a branch with no pull request", () => {
    const repo = setupRepo(box);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_yellow=");
    expect(reported).not.toContain("");
  });

  test("does not count a merged pull request's commits as unpushed once its remote branch is gone", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    const head = must(["git", "-C", repo, "rev-parse", "HEAD"]).trim();
    const mergedJson = box.write(
      "merged.json",
      `[{"number":8,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"${head}",` +
        '"updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]}]\n',
    );
    box.stub("gh", [`[ "$1 $2" = "pr list" ] && exec cat ${quote(mergedJson)}`, "exit 1"].join("\n"));
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_mauve=");
    expect(reported).not.toContain("");
  });

  test("turns a merged pull request yellow once commits land on top of it", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    const headParent = must(["git", "-C", repo, "rev-parse", "HEAD~1"]).trim();
    const mergedJson = box.write(
      "merged.json",
      `[{"number":8,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"${headParent}",` +
        '"updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]}]\n',
    );
    box.stub("gh", [`[ "$1 $2" = "pr list" ] && exec cat ${quote(mergedJson)}`, "exit 1"].join("\n"));
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_yellow= ");
    expect(reported).not.toContain("status_mauve=");
  });

  test("keeps the last report when the forge does not answer", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    box.stub("gh", "exit 1");
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    expect(existsSync(box.path("reported"))).toBe(false);
  });

  test("keeps the last report when a pull request's stack lookup fails", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    box.stub(
      "gh",
      [
        '[ "$1 $2" = "pr list" ] && exec echo \'[{"number":7,"state":"OPEN","isDraft":false,' +
          '"mergeable":"MERGEABLE","baseRefName":"main","headRefOid":"0000000",' +
          '"updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]}]\'',
        "exit 1",
      ].join("\n"),
    );
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    expect(existsSync(box.path("reported"))).toBe(false);
  });

  test("reads a merged pull request as merged when a closed one was touched later", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    const head = must(["git", "-C", repo, "rev-parse", "HEAD"]).trim();
    const prsJson = box.write(
      "prs.json",
      `[{"number":8,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"${head}",` +
        '"updatedAt":"2026-01-01T00:00:00Z","statusCheckRollup":[]},{"number":3,"state":"CLOSED",' +
        '"isDraft":false,"baseRefName":"main","headRefOid":"0000000","updatedAt":"2026-02-01T00:00:00Z",' +
        '"statusCheckRollup":[]}]\n',
    );
    box.stub("gh", [`[ "$1 $2" = "pr list" ] && exec cat ${quote(prsJson)}`, "exit 1"].join("\n"));
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).toContain("status_mauve=");
    expect(reported).not.toContain("status_dim=");
  });

  test("shows no branch row for a repository with no remote sitting on main", () => {
    const repo = setupRepo(box);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    must(["git", "-C", repo, "switch", "-q", "main"]);
    must(["git", "-C", repo, "remote", "remove", "origin"]);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).not.toContain("branch=");
    expect(reported).toContain("--clear-token");
  });

  test("clears every token for a clean checkout of the default branch", () => {
    const repo = setupRepo(box);
    stubGh(box, repo);
    must(["git", "-C", repo, "checkout", "-q", "--", "file"]);
    must(["git", "-C", repo, "switch", "-q", "main"]);
    const r = reportWorkspace(box);
    expect(r.status).toBe(0);
    const reported = box.read("reported");
    expect(reported).not.toContain("--token");
    expect(reported).toContain("--clear-token");
  });
});
