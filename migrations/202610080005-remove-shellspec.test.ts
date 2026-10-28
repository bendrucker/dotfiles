import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeIo, fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610080005-remove-shellspec";

let box: Sandbox;
let io: FakeIo;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("remove-shellspec");
  io = fakeIo({ answers: [{ argv: [] }] });
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(): Context {
  const home = box.mkdir("home");
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    io,
  };
}

function commands(): string[][] {
  return io.calls.map((call) => call.argv);
}

describe("remove-shellspec", () => {
  test("uninstalls the formula no Brewfile declares any more", () => {
    up(context());
    expect(commands().filter((cmd) => cmd[0]?.endsWith("brew") === true).map((cmd) => cmd.slice(1))).toEqual([
      ["list", "--versions", "shellspec"],
      ["uninstall", "shellspec"],
    ]);
  });
});
