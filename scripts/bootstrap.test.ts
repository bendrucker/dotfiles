import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

let box: Sandbox;

// bootstrap runs from the tree it sits in, so it is copied into a sandbox tree
// with homebrew.sh and dotf stubbed out, leaving setup_gitconfig to run for real.
beforeEach(() => {
  box = sandbox("bootstrap");
  box.mkdir("repo", "scripts", "shell");
  box.mkdir("repo", "git");
  for (const file of ["scripts/bootstrap", "scripts/shell/trace.sh", "git/config.local.example"]) {
    copyFileSync(join(repoRoot, file), box.path("repo", file));
  }
  box.stub("repo/scripts/homebrew.sh", "exit 0");
  box.write("repo/bin/dotf", "true\n");
  box.stub("git", "exit 0");
});

afterEach(() => {
  box.remove();
});

function bootstrap(input: string) {
  box.stub(
    "gum",
    `case "$1" in
  input) ${input} ;;
  log) shift; echo "$*" >&2 ;;
esac`,
  );
  return run(["bash", box.path("repo", "scripts", "bootstrap")], {
    path: [box.bin],
    env: { DOTFILES_TRACE_DIR: undefined },
  });
}

describe("bootstrap gitconfig", () => {
  test("writes no identity when gum input fails without a TTY", () => {
    const result = bootstrap("exit 1");

    expect(result.status).toBe(0);
    expect(existsSync(box.path("repo", "git", "config.local"))).toBe(false);
    expect(result.stderr).toContain("skipping gitconfig setup");
  });

  test("writes the identity it was given", () => {
    const result = bootstrap("echo jane");

    expect(result.status).toBe(0);
    expect(box.read("repo/git/config.local")).toContain("jane");
  });
});
