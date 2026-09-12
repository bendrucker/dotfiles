import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { exists, type Context } from "#migrations/migration";
import { up } from "./202609110001-remove-nvim-tmux-navigator";

let box: Sandbox;
let home: string;

beforeEach(() => {
  box = sandbox("remove-nvim-tmux-navigator");
  home = box.mkdir("home");
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    out: {
      write() {},
      run: () => 0,
      read: () => ({ status: 1, stdout: "" }),
    },
  };
}

const LOCK = join("home", ".config", "nvim", "nvim-pack-lock.json");

function pluginDir(name: string): string {
  return box.path("home", ".local", "share", "nvim", "site", "pack", "core", "opt", name);
}

// What vim.pack repaired onto a machine that still had the plugin installed:
// the declared entries plus vim-tmux-navigator, whose src it read back off the
// clone's own remote.
function lockWith(src: string): string {
  return `${JSON.stringify(
    {
      plugins: {
        "gitsigns.nvim": { rev: "6d808f99bd63303646794406e270bd553ad7792e", src: "https://github.com/lewis6991/gitsigns.nvim" },
        "vim-tmux-navigator": { rev: "e41c431a0c7b7388ae7ba341f01a0d217eb3a432", src },
      },
    },
    null,
    2,
  )}\n`;
}

const TRACKED = `${JSON.stringify(
  {
    plugins: {
      "gitsigns.nvim": { rev: "6d808f99bd63303646794406e270bd553ad7792e", src: "https://github.com/lewis6991/gitsigns.nvim" },
    },
  },
  null,
  2,
)}\n`;

describe("remove-nvim-tmux-navigator", () => {
  test("removes the plugin directory the tmux removal left installed", () => {
    box.mkdir("home", ".local", "share", "nvim", "site", "pack", "core", "opt", "vim-tmux-navigator", ".git");

    up(context());

    expect(exists(pluginDir("vim-tmux-navigator"))).toBe(false);
  });

  test("leaves the plugins init.lua still declares", () => {
    box.mkdir("home", ".local", "share", "nvim", "site", "pack", "core", "opt", "gitsigns.nvim");

    up(context());

    expect(exists(pluginDir("gitsigns.nvim"))).toBe(true);
  });

  // Removing only the directory would leave an entry vim.pack reinstalls from
  // on the next startup.
  test("restores a repaired lockfile to what the repo tracks", () => {
    box.write(LOCK, lockWith("https://github.com/christoomey/vim-tmux-navigator"));

    up(context());

    expect(box.read(LOCK)).toBe(TRACKED);
  });

  // The src vim.pack repaired in reads back off the clone's remote, so a
  // machine with an insteadOf rule recorded the SSH form of the same URL.
  test("restores it whatever form of the URL the machine recorded", () => {
    box.write(LOCK, lockWith("git@github.com:christoomey/vim-tmux-navigator"));

    up(context());

    expect(box.read(LOCK)).toBe(TRACKED);
  });

  test("leaves a lockfile that never carried the entry untouched", () => {
    box.write(LOCK, TRACKED);

    up(context());

    expect(box.read(LOCK)).toBe(TRACKED);
  });

  test("leaves a lockfile it cannot parse for nvim to repair", () => {
    box.write(LOCK, "{ not json");

    up(context());

    expect(box.read(LOCK)).toBe("{ not json");
  });

  test("a machine with neither the plugin nor a lockfile is not an error", () => {
    expect(() => up(context())).not.toThrow();
  });
});
