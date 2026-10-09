import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { TAP, up } from "./202610080006-rm-graphite";

let box: Sandbox;
let commands: string[][];
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("rm-graphite");
  commands = [];
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function brewCalls(): string[][] {
  return commands.filter((cmd) => cmd[0]?.endsWith("brew") === true).map((cmd) => cmd.slice(1));
}

// `installed` answers `brew list --versions`, and `taps` is what `brew tap` prints.
function context({ installed = true, taps = [TAP] }: { installed?: boolean; taps?: string[] } = {}): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("installed")],
    platform: "darwin",
    out: {
      write() {},
      run(cmd) {
        commands.push(cmd);
        return 0;
      },
      read(cmd) {
        commands.push(cmd);
        if (cmd[1] === "tap") return { status: 0, stdout: taps.map((tap) => `${tap}\n`).join("") };
        return { status: installed ? 0 : 1, stdout: "" };
      },
    },
  };
}

// The migration resolves brew off PATH, so a case that wants it found puts a stub there.
function stubBrew(): void {
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("rm-graphite", () => {
  test("uninstalls the formula, then untaps", () => {
    stubBrew();
    up(context());
    expect(brewCalls()).toEqual([
      ["list", "--versions", "withgraphite/tap/graphite"],
      ["uninstall", "withgraphite/tap/graphite"],
      ["tap"],
      ["untap", TAP],
    ]);
  });

  test("untaps when the formula is already gone", () => {
    stubBrew();
    up(context({ installed: false }));
    expect(brewCalls()).toEqual([["list", "--versions", "withgraphite/tap/graphite"], ["tap"], ["untap", TAP]]);
  });

  test("leaves brew alone when the tap is already gone", () => {
    stubBrew();
    up(context({ installed: false, taps: ["homebrew/core", "withgraphite/tap-other"] }));
    expect(brewCalls()).toEqual([["list", "--versions", "withgraphite/tap/graphite"], ["tap"]]);
  });

  test("does nothing on a machine with no brew", () => {
    process.env.PATH = box.mkdir("empty");
    up(context());
    expect(brewCalls()).toEqual([]);
  });
});
