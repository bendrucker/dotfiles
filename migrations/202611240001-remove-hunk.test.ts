import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { exists, type Context } from "#migrations/migration";
import { up } from "./202611240001-remove-hunk";

let box: Sandbox;
let installed: string;
let dir: string;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("remove-hunk");
  installed = box.mkdir("installed");
  dir = box.mkdir("home", ".config", "hunk");
  // No brew on PATH, so removeFormula returns before it runs anything.
  process.env.PATH = "";
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [installed],
    platform: "darwin",
  };
}

describe("remove-hunk", () => {
  test("removes the config link and the directory it leaves empty", async () => {
    symlinkSync(join(installed, "hunk", "config.toml"), join(dir, "config.toml"));

    await up(context());

    expect(exists(dir)).toBe(false);
  });

  test("leaves a config link pointing outside a dotfiles tree", async () => {
    symlinkSync(box.path("elsewhere.toml"), join(dir, "config.toml"));

    await up(context());

    expect(exists(join(dir, "config.toml"))).toBe(true);
  });

  test("leaves the directory when it holds anything else", async () => {
    symlinkSync(join(installed, "hunk", "config.toml"), join(dir, "config.toml"));
    writeFileSync(join(dir, "state.json"), "{}");

    await up(context());

    expect(exists(join(dir, "config.toml"))).toBe(false);
    expect(exists(join(dir, "state.json"))).toBe(true);
  });
});
