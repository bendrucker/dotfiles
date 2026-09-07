import { describe, expect, test } from "bun:test";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../scripts/lib/shell-fixtures.ts";

function gitConfig(key: string) {
  return run(["git", "config", "--global", "--get", key]);
}

describe("git", () => {
  test("loads the global config", () => {
    const r = gitConfig("alias.co");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("checkout");
  });

  test("pulls with rebase", () => {
    const r = gitConfig("pull.rebase");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  test("does not force fast-forward pulls, which would override pull.rebase", () => {
    const r = gitConfig("pull.ff");
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("autostashes before rebasing", () => {
    const r = gitConfig("rebase.autoStash");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  test("moves intermediate branch refs when rebasing a stack", () => {
    const r = gitConfig("rebase.updateRefs");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  test("resolves the ignore file referenced by core.excludesfile", () => {
    const excludes = gitConfig("core.excludesfile").stdout.trim();
    const expanded = excludes.replace(/^~/, process.env.HOME ?? "");
    expect(() => accessSync(expanded, constants.R_OK)).not.toThrow();
  });

  test("applies core.excludesfile to new repos", () => {
    const box = mkdtempSync(join(tmpdir(), "git-config-ignore-test-"));
    const repo = join(box, "ignore-test");
    run(["git", "init", "-q", repo]);
    const r = run(["git", "-C", repo, "check-ignore", "-q", ".DS_Store"]);
    rmSync(box, { recursive: true, force: true });
    expect(r.status).toBe(0);
  });
});
