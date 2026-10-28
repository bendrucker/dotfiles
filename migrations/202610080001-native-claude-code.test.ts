import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FakeIo, fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610080001-native-claude-code";

let box: Sandbox;
let io: FakeIo;
let installStatus: number;
let caskInstalled: boolean;

beforeEach(() => {
  box = sandbox("native-claude-code");
  io = fakeIo();
  installStatus = 0;
  caskInstalled = true;
});

afterEach(() => {
  box.remove();
});

const install = () => join(box.dir, "claude", "install-native");

function context(): Context {
  const brew = join(box.bin, "brew");
  io = fakeIo({
    answers: [
      { argv: [install()], status: installStatus },
      { argv: [brew, "list"], status: caskInstalled ? 0 : 1 },
      { argv: [brew, "uninstall"] },
    ],
  });
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

function ran(): string[][] {
  return io.calls.filter((call) => call.method === "run").map((call) => call.argv);
}

function withBrew(body: () => void): string {
  const brew = box.stub("brew", "");
  const saved = process.env.PATH;
  process.env.PATH = box.bin;
  try {
    body();
  } finally {
    process.env.PATH = saved;
  }
  return brew;
}

describe("native-claude-code", () => {
  test("installs the native build before uninstalling the cask", () => {
    const brew = withBrew(() => up(context()));

    expect(ran()).toEqual([[install()], [brew, "uninstall", "--cask", "claude-code@latest"]]);
  });

  test("keeps the cask when the native install fails", () => {
    installStatus = 1;

    expect(() => withBrew(() => up(context()))).toThrow("cask stays");
    expect(ran()).toEqual([[install()]]);
  });

  test("a machine without the cask only gets the native install", () => {
    caskInstalled = false;

    withBrew(() => up(context()));

    expect(ran()).toEqual([[install()]]);
  });
});
