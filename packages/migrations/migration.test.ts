import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { type Context, exists, removeFormula, removeTree } from "#migrations/migration";

let box: Sandbox;
let home: string;
// What the context's Output was asked to run, so a case can say which brew
// command the helper reached for.
let commands: string[][];

// The arguments of the brew calls, dropping the gum log lines the helpers write
// alongside them and the resolved path they lead with.
function brewCalls(): string[][] {
  return commands.filter((cmd) => cmd[0]?.endsWith("brew") === true).map((cmd) => cmd.slice(1));
}

beforeEach(() => {
  box = sandbox("migration");
  home = box.mkdir("home");
  commands = [];
});

afterEach(() => {
  box.remove();
});

function context(read: (cmd: string[]) => number = () => 0): Context {
  return {
    root: box.dir,
    home,
    config: join(home, ".config"),
    data: join(home, ".local", "share"),
    platform: "darwin",
    out: {
      write() {},
      run(cmd) {
        commands.push(cmd);
        return 0;
      },
      read(cmd) {
        commands.push(cmd);
        return { status: read(cmd), stdout: "" };
      },
    },
  };
}

// removeFormula resolves brew off PATH, so a case that wants it to find one
// puts a stub there. `brew list --versions` is what it asks.
function stubBrew(): void {
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${process.env.PATH ?? ""}`;
}

describe("removeTree", () => {
  test("removes a directory a retired topic's installer created", () => {
    const target = box.mkdir("home", ".tmux");
    removeTree(context(), target);
    expect(exists(target)).toBe(false);
  });

  test("a path that is already gone is not an error", () => {
    expect(() => removeTree(context(), join(home, "never-there"))).not.toThrow();
  });

  test("removes a dangling symlink, which stat alone reports as missing", () => {
    const link = join(home, ".config-link");
    symlinkSync(box.path("home", "gone"), link);
    expect(exists(link)).toBe(true);

    removeTree(context(), link);
    expect(exists(link)).toBe(false);
  });

  test("refuses a path outside the home it was handed", () => {
    const outside = box.mkdir("elsewhere");
    expect(() => removeTree(context(), outside)).toThrow(/outside/);
    expect(exists(outside)).toBe(true);
  });

  test("refuses the home directory itself", () => {
    expect(() => removeTree(context(), home)).toThrow(/outside/);
  });

  test("refuses a path that climbs back out through the home", () => {
    expect(() => removeTree(context(), join(home, "..", "elsewhere"))).toThrow(/outside/);
  });
});

describe("removeFormula", () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  test("uninstalls a formula that is installed", () => {
    stubBrew();
    removeFormula(context(), "tmux");
    expect(brewCalls()).toEqual([
      ["list", "--versions", "tmux"],
      ["uninstall", "tmux"],
    ]);
  });

  test("leaves a formula that is not installed alone", () => {
    stubBrew();
    removeFormula(context(() => 1), "tmux");
    expect(brewCalls()).toEqual([["list", "--versions", "tmux"]]);
  });

  test("does nothing on a machine with no brew, which is every Linux one here", () => {
    process.env.PATH = box.mkdir("empty");
    removeFormula(context(), "tmux");
    expect(brewCalls()).toEqual([]);
  });
});
