import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610080005-remove-shellspec";

let box: Sandbox;
let commands: string[][];
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("remove-shellspec");
  commands = [];
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
    out: {
      write() {},
      run(cmd) {
        commands.push(cmd);
        return 0;
      },
      read(cmd) {
        commands.push(cmd);
        return { status: 0, stdout: "" };
      },
    },
  };
}

describe("remove-shellspec", () => {
  test("uninstalls the formula no Brewfile declares any more", () => {
    up(context());
    expect(commands.filter((cmd) => cmd[0]?.endsWith("brew") === true).map((cmd) => cmd.slice(1))).toEqual([
      ["list", "--versions", "shellspec"],
      ["uninstall", "shellspec"],
    ]);
  });
});
