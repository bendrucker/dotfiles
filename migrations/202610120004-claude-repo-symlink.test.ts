import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { fakeIo, sandbox, type Sandbox } from "#harness";
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
    io: fakeIo({ answers: [{ argv: [] }] }),
  };
}

describe("claude-repo-symlink", () => {
  test.each<{ name: string; target: () => string }>([
    { name: "dangling", target: () => box.path("gone") },
    { name: "pointing at a directory that is not a clone", target: () => box.mkdir("plain") },
  ])("removes a symlink $name", ({ target }) => {
    symlinkSync(target(), repo);

    up(context());

    expect(lstatSync(repo, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("keeps a symlink to a clone", () => {
    box.mkdir("clone", ".git");
    symlinkSync(box.path("clone"), repo);

    up(context());

    expect(lstatSync(repo).isSymbolicLink()).toBe(true);
  });

  test("keeps a clone", () => {
    box.mkdir("home", ".claude-repo", ".git");

    up(context());

    expect(existsSync(box.path("home", ".claude-repo", ".git"))).toBe(true);
  });
});
