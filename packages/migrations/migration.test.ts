import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { type Context, exists, isEmpty, ownedLink, removeCask, removeFormula, removeTree } from "#migrations/migration";

let box: Sandbox;
let home: string;
let installed: string;
// What the context's Output was asked to run, so a case can say which brew
// command the helper reached for.
let commands: string[][];

function brewCalls(): string[][] {
  return commands.filter((cmd) => cmd[0]?.endsWith("brew") === true).map((cmd) => cmd.slice(1));
}

beforeEach(() => {
  box = sandbox("migration");
  home = box.mkdir("home");
  installed = box.mkdir("installed");
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
    applications: join(box.dir, "Applications"),
    installed: [installed],
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

  test("refuses a root even when another root contains it", () => {
    // An XDG variable left pointing at an ancestor of the home directory would
    // otherwise make the home directory a legal target.
    expect(() => removeTree({ ...context(), data: box.dir }, home)).toThrow(/is one of/);
    expect(exists(home)).toBe(true);
  });

  test("allows an XDG directory the context puts outside the home directory", () => {
    const data = box.mkdir("volume", "share");
    const target = box.mkdir("volume", "share", "tmux");

    removeTree({ ...context(), data }, target);

    expect(exists(target)).toBe(false);
  });

  test("refuses a path outside every directory it was handed", () => {
    const outside = box.mkdir("elsewhere");
    expect(() => removeTree(context(), outside)).toThrow(/outside/);
    expect(exists(outside)).toBe(true);
  });

  test("refuses the home directory itself", () => {
    expect(() => removeTree(context(), home)).toThrow(/is one of/);
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

describe("removeCask", () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  // Without --cask, `brew list` answers only for formulae and exits nonzero for
  // an installed cask, which would read as already gone and uninstall nothing.
  test("scopes both commands to casks", () => {
    stubBrew();
    removeCask(context(), "wispr-flow");
    expect(brewCalls()).toEqual([
      ["list", "--cask", "--versions", "wispr-flow"],
      ["uninstall", "--cask", "wispr-flow"],
    ]);
  });

  test("leaves a cask that is not installed alone", () => {
    stubBrew();
    removeCask(context(() => 1), "wispr-flow");
    expect(brewCalls()).toEqual([["list", "--cask", "--versions", "wispr-flow"]]);
  });

  test("does nothing on a machine with no brew", () => {
    process.env.PATH = box.mkdir("empty");
    removeCask(context(), "wispr-flow");
    expect(brewCalls()).toEqual([]);
  });
});

describe("ownedLink", () => {
  test("a link into one of the installed trees is this repo's", () => {
    const link = join(home, "link");
    symlinkSync(join(installed, "zsh"), link);

    expect(ownedLink(context(), link)).toBe(true);
  });

  test("a link somewhere else is not", () => {
    const link = join(home, "link");
    symlinkSync(box.mkdir("elsewhere"), link);

    expect(ownedLink(context(), link)).toBe(false);
  });

  test("a relative link resolves against the directory holding it", () => {
    const link = join(home, "link");
    symlinkSync(relative(home, join(installed, "zsh")), link);

    expect(ownedLink(context(), link)).toBe(true);
  });

  test("a real directory is not a link", () => {
    expect(ownedLink(context(), box.mkdir("home", "real"))).toBe(false);
  });
});

describe("isEmpty", () => {
  test("an empty directory", () => {
    expect(isEmpty(box.mkdir("home", "empty"))).toBe(true);
  });

  test("a directory holding something", () => {
    const dir = box.mkdir("home", "full");
    writeFileSync(join(dir, "file"), "");
    expect(isEmpty(dir)).toBe(false);
  });

  test("a path that is not there at all", () => {
    expect(isEmpty(join(home, "never-there"))).toBe(false);
  });
});
