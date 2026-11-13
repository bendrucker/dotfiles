import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { must, quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "rex", "try.sh");

let box: Sandbox;
let home: string;
let worktree: string;

function tryConfig(args: string[], env: Record<string, string> = {}) {
  return run([script, ...args], {
    cwd: box.dir,
    path: [box.bin],
    env: { HOME: home, MISE_ORIGINAL_CWD: box.dir, ...env },
  });
}

function pointer(): string {
  return join(home, ".local", "state", "rex", "try");
}

beforeEach(() => {
  box = sandbox("rex-try");
  home = box.mkdir("home");
  worktree = box.mkdir("worktree");
  box.write("worktree/rex/config/init.lua", "");
  box.stub("rex", `echo "$*" >> ${quote(box.path("calls"))}`);
});

describe("try", () => {
  test("points the deployed config at a worktree and reloads", () => {
    const result = tryConfig([worktree]);

    expect(result.status).toBe(0);
    expect(box.read("home/.local/state/rex/try")).toBe(`${worktree}/rex/config/init.lua\n`);
    expect(box.read("calls")).toBe(`config check ${worktree}/rex/config/init.lua\n--autostart=false config reload\n`);
  });

  test("defaults to the worktree mise was run from", () => {
    must(["git", "init", "--quiet", "--template=", worktree]);
    const top = must(["git", "-C", worktree, "rev-parse", "--show-toplevel"]).trim();

    const result = tryConfig([], { MISE_ORIGINAL_CWD: join(worktree, "rex") });

    expect(result.status).toBe(0);
    expect(box.read("home/.local/state/rex/try")).toBe(`${top}/rex/config/init.lua\n`);
  });

  test("refuses a directory without a Rex config", () => {
    const result = tryConfig([home]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no Rex config");
    expect(existsSync(pointer())).toBe(false);
    expect(existsSync(box.path("calls"))).toBe(false);
  });
});

test("restore removes the pointer and reloads", () => {
  expect(tryConfig([worktree]).status).toBe(0);

  const result = tryConfig(["--restore"]);

  expect(result.status).toBe(0);
  expect(existsSync(pointer())).toBe(false);
  expect(box.read("calls")).toEndWith("--autostart=false config reload\n--autostart=false config reload\n");
});
