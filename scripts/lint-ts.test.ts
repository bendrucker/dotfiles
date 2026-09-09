import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { bunScripts, clean, isBunScript, link, MIRROR, mirrorPath, rewrite } from "./lint-ts";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "lint-ts");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("lint-ts");
});

afterEach(() => {
  box.remove();
});

function git(args: string[]): void {
  const run = Bun.spawnSync({ cmd: ["git", "-C", box.dir, ...args], env: process.env, stdin: "ignore" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/**
 * A tree shaped like this repo: a git checkout carrying the oxlint config, the
 * pinned oxlint that config is meant to run under, a .ts module oxlint finds on
 * its own, and one extensionless bun executable it does not. `bunx oxlint`
 * walks up for node_modules and would otherwise go to the network from a
 * sandbox under the system temp directory.
 */
function fixture(executable: string, module = "export const ok = 1;\n"): void {
  git(["init", "--quiet"]);
  symlinkSync(join(REPO, "node_modules"), join(box.dir, "node_modules"));
  // oxlint reads .gitignore, which is how the real repo keeps the linter out
  // of the dependency it is installed from.
  box.write(".gitignore", "node_modules/\n");
  box.write(".oxlintrc.json", `${JSON.stringify({ rules: { "max-depth": ["error", 4] } })}\n`);
  box.write("packages/module.ts", module);
  box.stub("worktree-tool", executable, { shebang: "#!/usr/bin/env bun" });
  git(["add", "-A"]);
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

// Run through bun by path rather than by shebang, so the case does not depend
// on where bun sits on this machine's PATH.
function run(args: string[] = []): Outcome {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd: box.dir,
    env: { ...process.env, LINT_TS_ROOT: box.dir },
    stdin: "ignore",
  });
  return { status: spawned.exitCode, stdout: spawned.stdout.toString(), stderr: spawned.stderr.toString() };
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
    const found = await bunScripts(REPO);
    expect(found).toContain("bin/dotfiles-sync");
    expect(found).toContain("scripts/lint-expired");
    expect(found).not.toContain("bin/git-sync");
    expect(found.some((path) => path.endsWith(".ts"))).toBe(false);
  });

  // git ls-files reports a submodule by its gitlink path, which stats as a
  // directory and cannot be read as a file.
  test("passes over a submodule gitlink", async () => {
    const found = await bunScripts(REPO);
    expect(found).not.toContain("bat/catppuccin");
  });
});

describe("link and clean", () => {
  test("mirrors a script under a .ts name pointing at the original", () => {
    box.write("bin/wt-pr", "#!/usr/bin/env bun\n");
    link(box.dir, ["bin/wt-pr"]);

    const mirror = join(box.dir, mirrorPath("bin/wt-pr"));
    expect(mirror).toBe(join(box.dir, MIRROR, "bin/wt-pr.ts"));
    expect(readlinkSync(mirror)).toBe(join(box.dir, "bin/wt-pr"));
  });

  test("removes the mirror and the scratch directory it made", () => {
    link(box.dir, ["bin/wt-pr"]);
    clean(box.dir);

    expect(existsSync(join(box.dir, MIRROR))).toBe(false);
    expect(existsSync(join(box.dir, "tmp"))).toBe(false);
  });

  test("leaves other scratch in place", () => {
    box.write("tmp/notes", "kept\n");
    link(box.dir, ["bin/wt-pr"]);
    clean(box.dir);

    expect(box.read("tmp/notes")).toBe("kept\n");
  });
});

describe("rewrite", () => {
  test("maps a default-format diagnostic onto the real path", () => {
    const line = `${MIRROR}/bin/wt-pr.ts:12:3: error eslint(complexity): too complex`;
    expect(rewrite(line, ["bin/wt-pr"])).toBe("bin/wt-pr:12:3: error eslint(complexity): too complex");
  });

  // The annotation names the file twice, and GitHub reads the `file=` field.
  test("maps both paths in a github annotation", () => {
    const line = `::error file=${MIRROR}/bin/wt-pr.ts,line=12,title=x::${MIRROR}/bin/wt-pr.ts:12:3: nope`;
    expect(rewrite(line, ["bin/wt-pr"])).toBe("::error file=bin/wt-pr,line=12,title=x::bin/wt-pr:12:3: nope");
  });

  test("leaves a path it was not given alone", () => {
    const line = `${MIRROR}/bin/other.ts:1:1: error`;
    expect(rewrite(line, ["bin/wt-pr"])).toBe(line);
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

  test("explains itself", () => {
    const outcome = run(["--help"]);

    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("usage: lint-ts");
  });
});
