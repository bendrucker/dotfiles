import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610120002-dotfiles-through-confd";

let box: Sandbox;
let tree: string;
let home: string;
let config: string;
let confd: string;

beforeEach(() => {
  box = sandbox("dotfiles-through-confd");
  tree = box.mkdir("installed");
  box.write("installed/zsh/.zshenv", "zshenv\n");
  box.write("installed/neovim/config/init.lua", "init\n");
  box.write("installed/ssh/config", "ssh\n");
  home = box.mkdir("home");
  config = box.mkdir("home", ".config");
  box.mkdir("home", ".ssh");
  confd = join(config, "mise", "conf.d");
  box.mkdir("home", ".config", "mise");
  symlinkSync(tree, confd);
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: tree,
    home,
    config,
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [tree],
    platform: "darwin",
    io: fakeIo({ answers: [{ argv: [] }] }),
  };
}

describe("dotfiles-through-confd", () => {
  test("reroutes each link into the tree through conf.d", () => {
    symlinkSync(join(tree, "zsh", ".zshenv"), join(home, ".zshenv"));
    symlinkSync(join(tree, "ssh", "config"), join(home, ".ssh", "config"));
    symlinkSync(join(tree, "neovim", "config"), join(config, "nvim"));

    up(context());

    expect(readlinkSync(join(home, ".zshenv"))).toBe(join(confd, "zsh", ".zshenv"));
    expect(readlinkSync(join(home, ".ssh", "config"))).toBe(join(confd, "ssh", "config"));
    expect(readlinkSync(join(config, "nvim"))).toBe(join(confd, "neovim", "config"));
    expect(readFileSync(join(config, "nvim", "init.lua"), "utf8")).toBe("init\n");
  });

  test("removes a link whose file is gone", () => {
    box.mkdir("home", ".config", "retired");
    symlinkSync(join(tree, "retired", "config"), join(config, "retired", "config"));

    up(context());

    expect(existsSync(join(config, "retired", "config"))).toBe(false);
  });

  test("lays a missing conf.d before rerouting through it", () => {
    rmSync(confd);
    symlinkSync(join(tree, "zsh", ".zshenv"), join(home, ".zshenv"));

    up({ ...context(), installed: [tree, confd] });

    expect(readlinkSync(confd)).toBe(tree);
    expect(readFileSync(join(home, ".zshenv"), "utf8")).toBe("zshenv\n");
  });

  test("leaves links into a tree conf.d does not point at", () => {
    const other = box.write("other/zsh/.zshenv", "other\n");
    symlinkSync(other, join(home, ".zshenv"));

    up({ ...context(), installed: [tree, box.path("other")] });

    expect(readlinkSync(join(home, ".zshenv"))).toBe(other);
  });

  test("replaces a temporary link a killed run left behind", () => {
    symlinkSync(join(tree, "zsh", ".zshenv"), join(home, ".zshenv"));
    symlinkSync(join(tree, "zsh", ".zshenv"), join(home, ".zshenv.dotfiles-migrate"));

    up(context());

    expect(readlinkSync(join(home, ".zshenv"))).toBe(join(confd, "zsh", ".zshenv"));
  });

  test("leaves links into other trees, and conf.d itself, alone", () => {
    const elsewhere = box.write("elsewhere/file", "");
    symlinkSync(elsewhere, join(home, ".elsewhere"));

    up(context());

    expect(readlinkSync(join(home, ".elsewhere"))).toBe(elsewhere);
    expect(readlinkSync(confd)).toBe(tree);
  });
});
