import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "../scripts/lib/shell-fixtures.ts";

const dotfilesReload = join(repoRoot, "bin", "dotfiles-reload");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("dotfiles-reload");
  stubGum(box);

  // The dispatcher globs topics relative to its own parent, so it has to run
  // from a copy inside the fixture rather than from the repo.
  const target = box.write("bin/dotfiles-reload", readFileSync(dotfilesReload, "utf8"));
  chmodSync(target, 0o755);
});

afterEach(() => {
  box.remove();
});

function topic(name: string, status: number): void {
  box.stub(`${name}/reload.sh`, `echo "${name} reloaded"\nexit ${status}`);
}

function runReload(): Run {
  return run([box.path("bin", "dotfiles-reload")], { path: [box.bin] });
}

describe("dotfiles-reload", () => {
  test("runs every topic's reload.sh", () => {
    topic("alpha", 0);
    topic("beta", 0);
    const r = runReload();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("alpha reloaded");
    expect(r.stdout).toContain("beta reloaded");
  });

  test("exits 0 when no topic declares a reload", () => {
    const r = runReload();
    expect(r.status).toBe(0);
  });

  test("keeps going past a failing topic and reports its status", () => {
    topic("alpha", 3);
    topic("beta", 0);
    const r = runReload();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("beta reloaded");
    expect(r.stderr).toContain("alpha/reload.sh exited 3");
  });

  // A reload.sh that lost its exec bit would otherwise be run through the
  // shell's interpreter guess, or fail as "permission denied" every night.
  test("skips a reload.sh that is not executable", () => {
    topic("alpha", 0);
    chmodSync(box.path("alpha", "reload.sh"), 0o644);
    const r = runReload();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("alpha reloaded");
  });
});
