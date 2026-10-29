import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610120004-claude-repo-symlink";

let box: Sandbox;
let repo: string;

beforeEach(() => {
  box = sandbox("claude-repo-symlink");
  box.mkdir("home");
  repo = box.path("home", ".claude-repo");
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [],
    platform: "darwin",
  };
}

describe("claude-repo-symlink", () => {
  test.each<{ name: string; target: () => string }>([
    { name: "dangling", target: () => box.path("gone") },
    { name: "pointing at a directory that is not a clone", target: () => box.mkdir("plain") },
  ])("removes a symlink $name", async ({ target }) => {
    symlinkSync(target(), repo);

    await up(context());

    expect(lstatSync(repo, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("keeps a symlink to a clone", async () => {
    box.mkdir("clone", ".git");
    symlinkSync(box.path("clone"), repo);

    await up(context());

    expect(lstatSync(repo).isSymbolicLink()).toBe(true);
  });

  test("keeps a clone", async () => {
    box.mkdir("home", ".claude-repo", ".git");

    await up(context());

    expect(existsSync(box.path("home", ".claude-repo", ".git"))).toBe(true);
  });
});
