import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { FORMULAE, up } from "./202610120006-aws-golangci-lint-to-mise";

let box: Sandbox;
let commands: string[][];
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("aws-golangci-lint-to-mise");
  commands = [];
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.mkdir("home"),
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
      read: () => ({ status: 0, stdout: "" }),
    },
  };
}

describe("aws-golangci-lint-to-mise", () => {
  test("uninstalls each formula a mise pin replaced", () => {
    up(context());
    expect(commands.filter((cmd) => cmd[1] === "uninstall").map((cmd) => cmd.at(-1))).toEqual(FORMULAE);
  });
});
