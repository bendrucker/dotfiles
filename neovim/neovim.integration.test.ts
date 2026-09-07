import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const support = join(repoRoot, "neovim", "support");

// A cold runner starts nvim slowly and builds a treesitter parser per declared
// language, both well past the 5s a bun test gets by default.
const timeout = 300_000;

// nvim drops an nvim.log beside wherever it was started when something goes
// wrong, so it starts somewhere disposable rather than in the repo.
let box: Sandbox;

beforeEach(() => {
  box = sandbox("neovim");
});

afterEach(() => {
  box.remove();
});

describe("neovim", () => {
  test(
    "starts without errors",
    () => {
      const r = run(["nvim", "--headless", "+qa"], { cwd: box.dir });
      const output = r.stdout + r.stderr;
      if (r.status === 0 && /E[0-9]+:|stack traceback/.test(output)) {
        throw new Error(output);
      }
      expect(r.status).toBe(0);
    },
    timeout,
  );

  test(
    "resolves the configured statusline theme",
    () => {
      const r = run(["nvim", "--headless", "-c", `luafile ${join(support, "statusline_check.lua")}`], { cwd: box.dir });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toContain("resolves");
    },
    timeout,
  );

  test(
    "installs a working parser for every declared treesitter language",
    () => {
      const r = run(["nvim", "--headless", "-c", `luafile ${join(support, "treesitter_check.lua")}`], { cwd: box.dir });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toContain("tree-sitter CLI");
    },
    timeout,
  );
});
