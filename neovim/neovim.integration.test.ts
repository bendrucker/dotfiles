import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run } from "../scripts/lib/shell-fixtures.ts";

const support = join(repoRoot, "neovim", "support");

describe("neovim", () => {
  test("starts without errors", () => {
    const r = run(["nvim", "--headless", "+qa"]);
    const output = r.stdout + r.stderr;
    if (r.status === 0 && /E[0-9]+:|stack traceback/.test(output)) {
      throw new Error(output);
    }
    expect(r.status).toBe(0);
  });

  test("resolves the configured statusline theme", () => {
    const r = run(["nvim", "--headless", "-c", `luafile ${join(support, "statusline_check.lua")}`]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("resolves");
  });

  test("installs a working parser for every declared treesitter language", () => {
    const r = run(["nvim", "--headless", "-c", `luafile ${join(support, "treesitter_check.lua")}`]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("tree-sitter CLI");
  });
});
