import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { CRATE, up } from "./202610120003-rm-cargo-worktrunk-sync";

let box: Sandbox;
let commands: string[][];
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("rm-cargo-worktrunk-sync");
  commands = [];
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(status = 0): Context {
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
        return status;
      },
      read(cmd) {
        commands.push(cmd);
        return { status: 0, stdout: "" };
      },
    },
  };
}

function installCargoCopy(): void {
  mkdirSync(box.path("home", ".cargo", "bin"), { recursive: true });
  writeFileSync(box.path("home", ".cargo", "bin", "wt-sync"), "");
}

function cargoCalls(): string[][] {
  return commands.filter((cmd) => cmd[0]?.endsWith("cargo") === true).map((cmd) => cmd.slice(1));
}

// The migration resolves cargo off PATH, so a case that wants it found puts a stub there.
function stubCargo(): void {
  box.stub("cargo", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("rm-cargo-worktrunk-sync", () => {
  test("uninstalls the cargo copy", () => {
    installCargoCopy();
    stubCargo();
    up(context());
    expect(cargoCalls()).toEqual([["uninstall", CRATE]]);
  });

  test("leaves cargo alone when there is no cargo copy", () => {
    stubCargo();
    up(context());
    expect(cargoCalls()).toEqual([]);
  });

  test("warns rather than fails without cargo", () => {
    installCargoCopy();
    process.env.PATH = box.mkdir("empty");
    up(context());
    expect(cargoCalls()).toEqual([]);
    expect(commands.flat().join(" ")).toContain("remove ~/.cargo/bin/wt-sync by hand");
  });

  test("throws when the uninstall fails", () => {
    installCargoCopy();
    stubCargo();
    expect(() => up(context(101))).toThrow(`cargo uninstall ${CRATE} failed`);
  });
});
