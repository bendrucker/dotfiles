import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { must, repoRoot, run as spawn, type Run, sandbox, type Sandbox } from "#harness";
import { bunScripts, clean, isBunScript, link, MIRROR, mirrorDir, mirrorPath, rewrite } from "./lint-ts";

const SCRIPT = join(repoRoot, "scripts/lint-ts");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("lint-ts");
});

afterEach(() => {
  box.remove();
});

function git(args: string[]): void {
  must(["git", ...args], { cwd: box.dir });
}

/**
 * A tree shaped like this repo: a git checkout carrying the oxlint config, the
 * pinned oxlint that config is meant to run under, a .ts module oxlint finds on
 * its own, and one extensionless bun executable it does not, unless
 * `executable` is null. `bunx oxlint` walks up for node_modules and would
 * otherwise go to the network from a sandbox under the system temp directory.
 */
function fixture(executable: string | null, module = "export const ok = 1;\n"): void {
  git(["init", "--quiet"]);
  symlinkSync(join(repoRoot, "node_modules"), join(box.dir, "node_modules"));
  // oxlint reads .gitignore, which is how the real repo keeps the linter out
  // of the dependency it is installed from.
  box.write(".gitignore", "node_modules/\n");
  box.write(".oxlintrc.json", `${JSON.stringify({ rules: { "max-depth": ["error", 4] } })}\n`);
  box.write("packages/module.ts", module);
  if (executable !== null) box.stub("worktree-tool", executable, { shebang: "#!/usr/bin/env bun" });
  git(["add", "-A"]);
}

// Run through bun by path rather than by shebang, so the case does not depend
// on where bun sits on this machine's PATH.
function run(args: string[] = []): Run {
  return spawn([process.execPath, SCRIPT, ...args], { cwd: box.dir, env: { LINT_TS_ROOT: box.dir } });
}

const NESTED = [
  "export function deep(a: number): number {",
  "  if (a) { if (a) { if (a) { if (a) { if (a) { return 1 } } } } }",
  "  return 0",
  "}",
].join("\n");

describe("isBunScript", () => {
  test.each<{ name: string; path: string; shebang: string; expected: boolean }>([
    { name: "an extensionless bun executable", path: "bin/wt-pr", shebang: "#!/usr/bin/env bun", expected: true },
    { name: "trailing whitespace", path: "bin/wt-pr", shebang: "#!/usr/bin/env bun ", expected: true },
    { name: "a .ts file oxlint already finds", path: "bin/wt-pr.ts", shebang: "#!/usr/bin/env bun", expected: false },
    { name: "a bash executable", path: "bin/git-sync", shebang: "#!/usr/bin/env bash", expected: false },
    { name: "a bunx shebang", path: "bin/thing", shebang: "#!/usr/bin/env bunx", expected: false },
    { name: "a dot in a parent directory only", path: ".claude/run", shebang: "#!/usr/bin/env bun", expected: true },
    { name: "no shebang", path: "bin/thing", shebang: "import { x } from 'y'", expected: false },
  ])("$name", ({ path, shebang, expected }) => {
    expect(isBunScript(path, shebang)).toBe(expected);
  });
});

describe("bunScripts", () => {
  test("finds the tracked bun executables in this repo", async () => {
    const found = await bunScripts(repoRoot);
    expect(found).toContain("bin/dotfiles-sync");
    expect(found).toContain("scripts/lint-expired");
    expect(found).not.toContain("bin/git-sync");
    expect(found.some((path) => path.endsWith(".ts"))).toBe(false);
  });

  // git ls-files reports a submodule by its gitlink path, which stats as a
  // directory and cannot be read as a file.
  test("passes over a submodule gitlink", async () => {
    const found = await bunScripts(repoRoot);
    expect(found).not.toContain("bat/catppuccin");
  });

  // git tracks the link rather than what it points at, so a target that moved
  // leaves a path that stats as nothing.
  test("passes over a symlink whose target is gone", async () => {
    git(["init", "--quiet"]);
    symlinkSync(join(box.dir, "gone"), join(box.mkdir("bin"), "dangling"));
    git(["add", "-A"]);

    expect(await bunScripts(box.dir)).toEqual([]);
  });
});

describe("link and clean", () => {
  test("mirrors a script under a .ts name pointing at the original", () => {
    box.write("bin/wt-pr", "#!/usr/bin/env bun\n");
    link(box.dir, mirrorDir(7), ["bin/wt-pr"]);

    const mirror = join(box.dir, mirrorPath(mirrorDir(7), "bin/wt-pr"));
    expect(mirror).toBe(join(box.dir, MIRROR, "7/bin/wt-pr.ts"));
    expect(readlinkSync(mirror)).toBe(join(box.dir, "bin/wt-pr"));
  });

  test("removes the mirror and the scratch directory it made", () => {
    link(box.dir, mirrorDir(7), ["bin/wt-pr"]);
    clean(box.dir, mirrorDir(7));

    expect(existsSync(join(box.dir, MIRROR))).toBe(false);
    expect(existsSync(join(box.dir, "tmp"))).toBe(false);
  });

  // Two runs in one tree own separate directories, so neither cleanup takes
  // links the other is still linting.
  test("leaves another run's mirror in place", () => {
    box.write("bin/wt-pr", "#!/usr/bin/env bun\n");
    link(box.dir, mirrorDir(7), ["bin/wt-pr"]);
    link(box.dir, mirrorDir(8), ["bin/wt-pr"]);
    clean(box.dir, mirrorDir(7));

    expect(existsSync(join(box.dir, mirrorPath(mirrorDir(7), "bin/wt-pr")))).toBe(false);
    expect(existsSync(join(box.dir, mirrorPath(mirrorDir(8), "bin/wt-pr")))).toBe(true);
  });

  // rmSync takes a symlink rather than what it points at, so a scratch
  // directory someone linked in would go with it.
  test("leaves a tmp symlink alone", () => {
    const target = box.mkdir("elsewhere");
    symlinkSync(target, join(box.dir, "tmp"));
    clean(box.dir, mirrorDir(7));

    expect(readlinkSync(join(box.dir, "tmp"))).toBe(target);
  });

  test("leaves other scratch in place", () => {
    box.write("tmp/notes", "kept\n");
    link(box.dir, mirrorDir(7), ["bin/wt-pr"]);
    clean(box.dir, mirrorDir(7));

    expect(box.read("tmp/notes")).toBe("kept\n");
  });
});

describe("rewrite", () => {
  const DIR = mirrorDir(7);

  test("maps a default-format diagnostic onto the real path", () => {
    const line = `${DIR}/bin/wt-pr.ts:12:3: error eslint(complexity): too complex`;
    expect(rewrite(line, DIR, ["bin/wt-pr"])).toBe("bin/wt-pr:12:3: error eslint(complexity): too complex");
  });

  // The annotation names the file twice, and GitHub reads the `file=` field.
  test("maps both paths in a github annotation", () => {
    const line = `::error file=${DIR}/bin/wt-pr.ts,line=12,title=x::${DIR}/bin/wt-pr.ts:12:3: nope`;
    expect(rewrite(line, DIR, ["bin/wt-pr"])).toBe("::error file=bin/wt-pr,line=12,title=x::bin/wt-pr:12:3: nope");
  });

  test("leaves a path it was not given alone", () => {
    const line = `${DIR}/bin/other.ts:1:1: error`;
    expect(rewrite(line, DIR, ["bin/wt-pr"])).toBe(line);
  });
});

describe("lint-ts", () => {
  test("reports a violation in an extensionless executable against its own path", () => {
    fixture(NESTED);
    const outcome = run();

    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain("bin/worktree-tool:3:");
    expect(outcome.stdout).toContain("max-depth");
    expect(outcome.stdout).not.toContain(MIRROR);
  });

  test("passes an executable the thresholds allow", () => {
    fixture("export const shallow = (a: number): number => (a ? 1 : 0)\n");
    const outcome = run();

    expect(outcome.status).toBe(0);
  });

  test("reports a violation in a .ts module oxlint finds on its own", () => {
    fixture("export const shallow = (a: number): number => (a ? 1 : 0)\n", NESTED);
    const outcome = run();

    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain("packages/module.ts:2:");
  });

  test("leaves no mirror behind", () => {
    fixture(NESTED);
    run();

    expect(existsSync(join(box.dir, MIRROR))).toBe(false);
  });

  // link() makes no directory for an empty list, and oxlint exits 1 on a path
  // that is not there.
  test("passes a tree with no bun executables", () => {
    fixture(null);

    const outcome = run();

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("No files found to lint");
  });

  // A killed run leaves its mirror behind. The repo pass ignores the whole
  // mirror root, so the leftover is not linted as ordinary source.
  test("ignores a mirror another run left behind", () => {
    fixture("export const shallow = (a: number): number => (a ? 1 : 0)\n");
    box.write("bin/stale", NESTED);
    link(box.dir, mirrorDir(999), ["bin/stale"]);

    const outcome = run();

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("bin/stale");
  });

  test("explains itself", () => {
    const outcome = run(["--help"]);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("usage: lint-ts");
  });
});
