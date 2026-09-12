import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const support = join(repoRoot, "neovim", "support");

// Where neovim/symlinks.conf puts the config, and so where nvim reads
// stdpath('config') from. Resolved through the link, because the checkout that
// has to stay clean is the one the link points into rather than whichever tree
// this test was started from.
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const installedLock = join(configHome, "nvim", "nvim-pack-lock.json");

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
    "leaves the lockfile the repo tracks alone once the plugins are installed",
    () => {
      // vim.pack reconciles the lockfile against the plugin directory on every
      // startup, and the lockfile lands in the repo through the neovim/config
      // symlink. A plugin installed but no longer declared is repaired back in
      // on each start, which leaves the checkout dirty and holds the nightly
      // sync shut.
      expect(run(["nvim", "--headless", "+qa"], { cwd: box.dir }).status).toBe(0);

      const tracked = realpathSync(installedLock);
      const before = readFileSync(tracked, "utf8");
      expect(run(["nvim", "--headless", "+qa"], { cwd: box.dir }).status).toBe(0);
      expect(readFileSync(tracked, "utf8")).toBe(before);

      // The status is asserted too: a lockfile sitting outside any checkout
      // would report nothing dirty and pass without looking at anything.
      const status = run(["git", "-C", dirname(tracked), "status", "--porcelain", "--", tracked]);
      expect(status.status).toBe(0);
      expect(status.stdout).toBe("");
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
      const output = r.stdout + r.stderr;
      // The FAIL: lines name which language broke and why, so they are asserted
      // before the status. A bare status assertion reports the exit code alone
      // and discards them.
      expect(output).not.toContain("FAIL:");
      expect(output).toContain("tree-sitter CLI");
      expect(r.status).toBe(0);
    },
    timeout,
  );
});
