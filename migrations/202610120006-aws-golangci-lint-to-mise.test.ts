import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeIo, fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { FORMULAE, up } from "./202610120006-aws-golangci-lint-to-mise";

let box: Sandbox;
let io: FakeIo;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("aws-golangci-lint-to-mise");
  io = fakeIo({ answers: [{ argv: [] }] });
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
    io,
  };
}

describe("aws-golangci-lint-to-mise", () => {
  test("uninstalls each formula a mise pin replaced", () => {
    up(context());
    expect(io.calls.map((call) => call.argv).filter((cmd) => cmd[1] === "uninstall").map((cmd) => cmd.at(-1))).toEqual(FORMULAE);
  });
});
