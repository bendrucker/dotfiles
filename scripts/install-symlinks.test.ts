import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const installSymlinks = join(repoRoot, "scripts", "install-symlinks");

let box: Sandbox;
let root: string;
let otherRoot: string;
let home: string;
let xdg: string;

beforeEach(() => {
  box = sandbox("install-symlinks");
  root = box.path("root");
  otherRoot = box.path("other-root");
  home = box.path("home");
  xdg = join(home, ".config");

  // Declared source for one desired link, under a fake dotfiles root.
  box.mkdir("root", "topic");
  box.mkdir("other-root");
  box.mkdir("home", ".config");
  box.write("root/topic/kept.conf", "kept\n");
  box.write("root/topic/symlinks.conf", "kept.conf:~/.kept\n");

  // Stale link directly under HOME: points into root but not declared.
  box.write("root/stale-source", "stale\n");
  symlinkSync(join(root, "stale-source"), join(home, ".stale"));

  // Stale link nested under XDG: points into root but not declared.
  box.mkdir("home", ".config", "nested");
  symlinkSync(join(root, "stale-source"), join(xdg, "nested", "stale"));

  // Unrelated link under HOME: points outside root, must be left alone.
  box.write("other-root/unrelated-source", "unrelated\n");
  symlinkSync(join(otherRoot, "unrelated-source"), join(home, ".unrelated"));
});

afterEach(() => {
  box.remove();
});

function runInstall() {
  return run([installSymlinks, root], { env: { HOME: home, XDG_CONFIG_HOME: xdg } });
}

describe("install-symlinks remove_stale", () => {
  test("creates declared links, removes stale links into root, and preserves the rest", () => {
    const r = runInstall();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`removing stale symlink ${home}/.stale`);
    expect(r.stdout).toContain(`removing stale symlink ${xdg}/nested/stale`);
    expect(lstatSync(join(home, ".kept")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".stale"))).toBe(false);
    expect(existsSync(join(xdg, "nested", "stale"))).toBe(false);
    expect(lstatSync(join(home, ".unrelated")).isSymbolicLink()).toBe(true);
  });
});
