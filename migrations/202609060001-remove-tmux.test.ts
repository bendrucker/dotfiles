import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202609060001-remove-tmux";

let box: Sandbox;
let home: string;
let installed: string;

beforeEach(() => {
  box = sandbox("remove-tmux");
  home = box.mkdir("home");
  installed = box.mkdir("installed");
});

afterEach(() => {
  box.remove();
});

// No brew on PATH, so removeFormula returns before it can run anything. The
// uninstall path has its own cases in packages/migrations/migration.test.ts;
// what this file covers is which paths the migration reaches for.
function context(): Context {
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [installed],
    platform: "darwin",
  };
}

async function withoutBrew(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

describe("remove-tmux", () => {
  test("removes what the deleted tmux/install.sh created", async () => {
    const plugins = box.mkdir("home", ".local", "share", "tmux", "plugins", "tpm");
    const dotTmux = box.mkdir("home", ".tmux");

    await withoutBrew(() => up(context()));

    expect(exists(plugins)).toBe(false);
    expect(exists(box.path("home", ".local", "share", "tmux"))).toBe(false);
    expect(exists(dotTmux)).toBe(false);
  });

  test("leaves a ~/.tmux holding something the installer never put there", async () => {
    const dotTmux = box.mkdir("home", ".tmux");
    writeFileSync(join(dotTmux, "notes"), "");

    await withoutBrew(() => up(context()));

    expect(exists(join(dotTmux, "notes"))).toBe(true);
  });

  test("removes the config link the deleted tmux/symlinks.conf made", async () => {
    const config = box.mkdir("home", ".config");
    const link = join(config, "tmux");
    symlinkSync(join(installed, "tmux"), link);

    await withoutBrew(() => up(context()));

    expect(exists(link)).toBe(false);
  });

  test("leaves a config link pointing somewhere other than a dotfiles tree", async () => {
    const config = box.mkdir("home", ".config");
    const link = join(config, "tmux");
    symlinkSync(box.mkdir("elsewhere", "tmux"), link);

    await withoutBrew(() => up(context()));

    expect(exists(link)).toBe(true);
  });

  test("leaves a real config directory someone put back by hand", async () => {
    const config = box.mkdir("home", ".config", "tmux");
    writeFileSync(join(config, "tmux.conf"), "");

    await withoutBrew(() => up(context()));

    expect(exists(join(config, "tmux.conf"))).toBe(true);
  });

  test("a machine with none of it left is not an error", async () => {
    mkdirSync(join(home, ".config"), { recursive: true });
    await expect(withoutBrew(() => up(context()))).resolves.toBeUndefined();
  });
});
