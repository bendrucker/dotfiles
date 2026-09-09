import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ordinary, secrets } from "#history-secrets";
import { run, sandbox } from "#harness";

// The installed config, not the one in the worktree: what protects the synced
// store is the file atuin actually reads.
const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config");
const installed = join(xdgConfigHome, "atuin", "config.toml");

const box = sandbox("atuin-history-filter");
afterAll(() => box.remove());

beforeAll(() => {
  // data_dir has to lead: it is a top-level key, and the installed file ends in
  // a [sync] table that would otherwise claim it. Sending atuin at a sandbox
  // database keeps the real history untouched.
  const data = box.mkdir("data");
  box.write("config/config.toml", `data_dir = ${JSON.stringify(data)}\n${readFileSync(installed, "utf8")}`);
});

/**
 * atuin prints the new row's id when it records a command and nothing when a
 * filter rejects it, so the hook the shell calls is also the oracle here.
 */
function records(command: string): boolean {
  const r = run(["atuin", "history", "start", "--hook", "--", command], {
    env: { ATUIN_CONFIG_DIR: box.path("config"), ATUIN_SHELL: "zsh" },
  });
  // A filtered command and a failed atuin both print nothing, so a non-zero
  // status has to be told apart from a rejection rather than read as one.
  if (r.status !== 0) throw new Error(`atuin exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout.trim() !== "";
}

describe("atuin", () => {
  test("symlinks the config into place", () => {
    expect(readFileSync(installed, "utf8")).toContain("history_filter");
  });

  test("records an ordinary command, so a silent no-op would show up here", () => {
    expect(records("git log --oneline -5")).toBe(true);
  });

  for (const { name, command } of secrets) {
    test(`drops ${name}`, () => {
      expect(records(command)).toBe(false);
    });
  }

  for (const { name, command } of ordinary) {
    test(`keeps ${name}`, () => {
      expect(records(command)).toBe(true);
    });
  }
});
