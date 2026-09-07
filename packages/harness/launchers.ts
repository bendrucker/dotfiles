import { expect, test } from "bun:test";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { commandExists, repoRoot, resolveOnPath, run } from "./index.ts";

// Every launcher in a topic's bin/ clears the same three checks before its own
// behavior is worth asserting on, and a launcher added later gets them by
// naming itself here rather than by copying them again.
export function launcherContract(topic: string, name: string): void {
  const launcher = join(repoRoot, topic, "bin", name);

  test("is executable", () => {
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  test.skipIf(!commandExists("shellcheck"))("passes shellcheck", () => {
    // shellcheck writes its findings to stdout, so asserting on the output is
    // what puts the finding itself in the failure.
    const check = run(["shellcheck", launcher]);
    expect(check.stdout + check.stderr).toBe("");
  });

  // path.zsh is one of the two files .zshrc skips, so sourcing it under a
  // chosen $ZSH root is what a login shell does to it. -f keeps the installed
  // root out, which is what makes this the worktree rather than ~/.dotfiles.
  test("is reachable on PATH from a login shell", () => {
    expect(resolveOnPath(topic, name)).toBe(realpathSync(launcher));
  });
}
