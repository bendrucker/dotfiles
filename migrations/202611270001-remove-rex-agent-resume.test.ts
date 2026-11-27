import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { type Context, exists } from "#migrations/migration";
import { up } from "./202611270001-remove-rex-agent-resume";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("remove-rex-agent-resume");
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

describe("remove-rex-agent-resume", () => {
  test("removes the clone and its state", async () => {
    const clone = box.mkdir("home", ".local", "share", "rex-agent-resume", "bin");
    const state = box.mkdir("home", ".local", "state", "rex-agent-resume", "agents");

    await up(context());

    expect(exists(clone)).toBe(false);
    expect(exists(state)).toBe(false);
  });

  test("a machine without them is untouched", async () => {
    await expect(up(context())).resolves.toBeUndefined();
  });
});
