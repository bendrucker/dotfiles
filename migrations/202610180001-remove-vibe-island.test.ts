import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { type Context, exists } from "#migrations/migration";
import { up } from "./202610180001-remove-vibe-island";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("remove-vibe-island");
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  const home = box.mkdir("home");
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.mkdir("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
  };
}

// No brew on PATH, so removeCask returns before it can run anything.
async function withoutBrew(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

describe("remove-vibe-island", () => {
  test("removes the bridge and cache", async () => {
    const ctx = context();
    const tree = box.mkdir("home", ".vibe-island", "bin");

    await withoutBrew(() => up(ctx));

    expect(exists(tree)).toBe(false);
    expect(exists(box.path("home", ".vibe-island"))).toBe(false);
    expect(exists(ctx.home)).toBe(true);
  });

  test("a machine without it is untouched", async () => {
    const ctx = context();
    await withoutBrew(() => up(ctx));
    expect(exists(ctx.home)).toBe(true);
  });
});
