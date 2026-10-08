import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { up } from "./202610080001-native-claude-code";

let box: Sandbox;
let ran: string[][];
let installStatus: number;
let caskInstalled: boolean;

beforeEach(() => {
  box = sandbox("native-claude-code");
  ran = [];
  installStatus = 0;
  caskInstalled = true;
});

afterEach(() => {
  box.remove();
});

const install = () => join(box.dir, "claude", "install-native");

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
        if (cmd[0] !== "gum") ran.push(cmd);
        return cmd[0] === install() ? installStatus : 0;
      },
      read: () => ({ status: caskInstalled ? 0 : 1, stdout: "" }),
    },
  };
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

    expect(ran).toEqual([[install()], [brew, "uninstall", "--cask", "claude-code@latest"]]);
  });

  test("keeps the cask when the native install fails", () => {
    installStatus = 1;

    expect(() => withBrew(() => up(context()))).toThrow("cask stays");
    expect(ran).toEqual([[install()]]);
  });

  test("a machine without the cask only gets the native install", () => {
    caskInstalled = false;

    withBrew(() => up(context()));

    expect(ran).toEqual([[install()]]);
  });
});
