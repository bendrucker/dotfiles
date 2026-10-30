import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, sandbox, type Sandbox } from "#harness";
import { idleSecs, newestChange, statusPaths } from "./activity.ts";
import { nowSeconds } from "./state.ts";

const DAY = 86400;

let box: Sandbox;
let repo: string;

beforeEach(() => {
  box = sandbox("activity");
  repo = box.mkdir("repo");
  must(["git", "init", "-q", "-b", "main", repo]);
  must(["git", "-C", repo, "config", "user.name", "t"]);
  must(["git", "-C", repo, "config", "user.email", "t@t.test"]);
  writeFileSync(join(repo, "tracked"), "one");
  must(["git", "-C", repo, "add", "tracked"]);
  must(["git", "-C", repo, "commit", "-q", "-m", "init"]);
});

afterEach(() => {
  box.remove();
});

function backdate(path: string, days: number): void {
  const when = nowSeconds() - days * DAY;
  utimesSync(path, when, when);
}

describe("statusPaths", () => {
  test.each<{ name: string; captured: string; paths: string[] }>([
    { name: "each entry's path", captured: " M a\0?? dir/\0", paths: ["a", "dir/"] },
    { name: "no rename or copy origin", captured: "R  new\0old\0C  copy\0src\0 M b\0", paths: ["new", "copy", "b"] },
    { name: "nothing from a clean tree", captured: "", paths: [] },
  ])("reads $name", ({ captured, paths }) => {
    expect(statusPaths(captured)).toEqual(paths);
  });
});

describe("newestChange", () => {
  test("is undefined for a clean tree", async () => {
    expect(await newestChange(repo)).toBeUndefined();
  });

  test("is the newest mtime among changed paths", async () => {
    writeFileSync(join(repo, "tracked"), "two");
    writeFileSync(join(repo, "untracked"), "new");
    backdate(join(repo, "tracked"), 10);
    backdate(join(repo, "untracked"), 3);
    expect(await newestChange(repo)).toBe(nowSeconds() - 3 * DAY);
  });

  test("dates an untracked directory by its own mtime", async () => {
    const dir = box.mkdir("repo", "scratch");
    writeFileSync(join(dir, "inner"), "x");
    backdate(join(dir, "inner"), 1);
    backdate(dir, 20);
    expect(await newestChange(repo)).toBe(nowSeconds() - 20 * DAY);
  });

  test("ignores a deleted path, which has nothing to stat", async () => {
    must(["rm", join(repo, "tracked")]);
    expect(await newestChange(repo)).toBeUndefined();
  });
});

describe("idleSecs", () => {
  test("a fresh worktree is not idle, whatever its tip commit's age", async () => {
    const idle = await idleSecs({ path: repo, timestamp: nowSeconds() - 400 * DAY });
    expect(idle).toBeLessThan(60);
  });

  test("falls back to the tip commit for a path that no longer exists", async () => {
    const idle = await idleSecs({ path: box.path("gone"), timestamp: nowSeconds() - 5 * DAY });
    expect(idle).toBeGreaterThanOrEqual(5 * DAY);
    expect(idle).toBeLessThan(5 * DAY + 60);
  });

  test("is undefined when no clock reads", async () => {
    expect(await idleSecs({ path: box.path("gone"), timestamp: 0 })).toBeUndefined();
  });
});
