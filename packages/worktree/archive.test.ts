import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, run, sandbox, type Sandbox } from "#harness";
import { archive, pruneArchives, RETENTION } from "./archive.ts";
import { nowSeconds } from "./state.ts";

const DAY = 86400;

let box: Sandbox;
let repo: string;
let tree: string;

beforeEach(() => {
  box = sandbox("archive");
  repo = box.mkdir("repo");
  tree = box.path("tree");
  must(["git", "init", "-q", "-b", "main", repo]);
  must(["git", "-C", repo, "config", "user.name", "t"]);
  must(["git", "-C", repo, "config", "user.email", "t@t.test"]);
  writeFileSync(join(repo, "tracked"), "one");
  writeFileSync(join(repo, "staged"), "one");
  writeFileSync(join(repo, ".gitignore"), "ignored\n");
  must(["git", "-C", repo, "add", "."]);
  must(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  must(["git", "-C", repo, "worktree", "add", "-q", "-b", "topic", tree]);
});

afterEach(() => {
  box.remove();
});

function gitdir(path: string): string {
  return must(["git", "-C", path, "rev-parse", "--absolute-git-dir"]).trim();
}

function dirty(): void {
  writeFileSync(join(tree, "tracked"), "two");
  writeFileSync(join(tree, "staged"), "staged edit");
  must(["git", "-C", tree, "add", "staged"]);
  writeFileSync(join(tree, "untracked"), "new\0binary");
  box.mkdir("tree", "dir");
  writeFileSync(join(tree, "dir", "nested"), "deep");
  writeFileSync(join(tree, "ignored"), "lost");
}

describe("archive", () => {
  test("a restore reproduces tracked and untracked files byte for byte", async () => {
    dirty();
    const ref = await archive(tree, "topic");
    expect(ref).toMatch(/^refs\/archive\/wt\/topic\/[0-9]{8}$/);

    const restored = box.path("restored");
    must(["git", "-C", repo, "worktree", "add", "-q", "--detach", restored, ref as string]);
    for (const file of ["tracked", "staged", "untracked", "dir/nested", ".gitignore"]) {
      expect(readFileSync(join(restored, file))).toEqual(readFileSync(join(tree, file)));
    }
    expect(run(["test", "-e", join(restored, "ignored")]).status).not.toBe(0);
  });

  test("keeps a file force-added past .gitignore", async () => {
    writeFileSync(join(tree, "ignored"), "forced");
    must(["git", "-C", tree, "add", "-f", "ignored"]);
    const ref = (await archive(tree, "topic")) as string;
    expect(must(["git", "-C", repo, "show", `${ref}:ignored`])).toBe("forced");
  });

  test("leaves the worktree's own index and status as they were", async () => {
    dirty();
    const index = join(gitdir(tree), "index");
    const before = readFileSync(index);
    const status = must(["git", "-C", tree, "status", "--porcelain"]);

    await archive(tree, "topic");

    expect(readFileSync(index)).toEqual(before);
    expect(must(["git", "-C", tree, "status", "--porcelain"])).toBe(status);
    expect(readdirSync(gitdir(tree)).filter((name) => name.startsWith("wt-archive-index"))).toEqual([]);
  });

  test("records the snapshot on top of HEAD", async () => {
    dirty();
    const ref = (await archive(tree, "topic")) as string;
    const head = must(["git", "-C", tree, "rev-parse", "HEAD"]).trim();
    expect(must(["git", "-C", repo, "rev-parse", `${ref}^`]).trim()).toBe(head);
    expect(must(["git", "-C", repo, "log", "-1", "--format=%s", ref]).trim()).toBe(`wt archive: topic ${tree}`);
  });

  test("a second archive the same day keeps the first", async () => {
    dirty();
    const first = (await archive(tree, "topic")) as string;
    writeFileSync(join(tree, "tracked"), "three");
    const second = (await archive(tree, "topic")) as string;
    expect(second).not.toBe(first);
    expect(second.startsWith(`${first}-`)).toBe(true);
    expect(must(["git", "-C", repo, "show", `${first}:tracked`])).toBe("two");
    expect(must(["git", "-C", repo, "show", `${second}:tracked`])).toBe("three");
  });

  test("is undefined when a step fails", async () => {
    dirty();
    box.stub(
      "git",
      `for arg; do [ "$arg" = commit-tree ] && exit 1; done; exec ${must(["sh", "-c", "command -v git"]).trim()} "$@"`,
    );
    const path = process.env.PATH;
    process.env.PATH = `${box.bin}:${path}`;
    try {
      expect(await archive(tree, "topic")).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
    expect(must(["git", "-C", repo, "for-each-ref", "refs/archive"])).toBe("");
  });

  test("is undefined for a path that is not a worktree", async () => {
    expect(await archive(box.path("gone"), "gone")).toBeUndefined();
  });

  test("refuses a sparse checkout, whose missing files would read as deleted", async () => {
    must(["git", "-C", tree, "config", "core.sparseCheckout", "true"]);
    expect(await archive(tree, "topic")).toBeUndefined();
  });
});

describe("pruneArchives", () => {
  function archived(ref: string, days: number, subject = "wt archive: x /x"): void {
    const date = `${nowSeconds() - days * DAY} +0000`;
    const env = { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
    const tree = must(["git", "-C", repo, "write-tree"]).trim();
    const commit = must(["git", "-C", repo, "commit-tree", tree, "-m", subject], { env }).trim();
    must(["git", "-C", repo, "update-ref", ref, commit]);
  }

  function refs(): string[] {
    return must(["git", "-C", repo, "for-each-ref", "--format=%(refname)", "refs/archive"])
      .split("\n")
      .filter((line) => line !== "");
  }

  test("deletes a snapshot past retention and keeps a younger one", async () => {
    archived("refs/archive/wt/old/20200101", 91);
    archived("refs/archive/wt/young/20200101", 89);
    expect(await pruneArchives(RETENTION, repo)).toBe(1);
    expect(refs()).toEqual(["refs/archive/wt/young/20200101"]);
  });

  test.each<{ name: string; ref: string; subject: string }>([
    { name: "a branch archive under the same prefix", ref: "refs/archive/wt/branch", subject: "some branch tip" },
    { name: "a ref with the subject but not the dated leaf", ref: "refs/archive/wt/release", subject: "wt archive: notes" },
  ])("leaves $name alone", async ({ ref, subject }) => {
    archived(ref, 400, subject);
    expect(await pruneArchives(RETENTION, repo)).toBe(0);
    expect(refs()).toEqual([ref]);
  });

  test("deletes a suffixed snapshot past retention", async () => {
    archived("refs/archive/wt/x/20200101-0123456789ab", 91);
    expect(await pruneArchives(RETENTION, repo)).toBe(1);
  });
});
