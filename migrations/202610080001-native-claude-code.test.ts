import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { up } from "./202610080001-native-claude-code";

let box: Sandbox;
let installStatus: number;
let caskInstalled: boolean;

beforeEach(() => {
  box = sandbox("native-claude-code");
  installStatus = 0;
  caskInstalled = true;
});

afterEach(() => {
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
  };
}

async function withBrew(body: () => Promise<void>): Promise<void> {
  recordingStub(box, "claude/install-native", `exit ${installStatus}`);
  recordingStub(box, "brew", `[ "$1" = list ] && exit ${caskInstalled ? 0 : 1}
exit 0`);
  const saved = process.env.PATH;
  process.env.PATH = `${box.bin}:${saved ?? ""}`;
  try {
    await body();
  } finally {
    process.env.PATH = saved;
  }
}

function calls(): string[][] {
  return recorded(box);
}

describe("native-claude-code", () => {
  test("installs the native build before uninstalling the cask", async () => {
    await withBrew(() => up(context()));

    expect(calls()).toEqual([
      ["install-native"],
      ["brew", "list", "--cask", "--versions", "claude-code@latest"],
      ["brew", "uninstall", "--cask", "claude-code@latest"],
    ]);
  });

  test("keeps the cask when the native install fails", async () => {
    installStatus = 1;

    await expect(withBrew(() => up(context()))).rejects.toThrow("cask stays");
    expect(calls()).toEqual([["install-native"]]);
  });

  test("a machine without the cask only gets the native install", async () => {
    caskInstalled = false;

    await withBrew(() => up(context()));

    expect(calls()).toEqual([
      ["install-native"],
      ["brew", "list", "--cask", "--versions", "claude-code@latest"],
    ]);
  });
});
