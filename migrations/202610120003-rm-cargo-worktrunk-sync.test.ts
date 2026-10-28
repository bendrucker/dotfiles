import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { type FakeIo, fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { CRATE, up } from "./202610120003-rm-cargo-worktrunk-sync";

let box: Sandbox;
let io: FakeIo;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("rm-cargo-worktrunk-sync");
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

// Every command the migration runs exits with `status`.
function context(status = 0): Context {
  io = fakeIo({ answers: [{ argv: [], status }] });
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("installed")],
    platform: "darwin",
    io,
  };
}

function installCargoCopy(): void {
  mkdirSync(box.path("home", ".cargo", "bin"), { recursive: true });
  writeFileSync(box.path("home", ".cargo", "bin", "wt-sync"), "");
}

function cargoCalls(): string[][] {
  return io.calls.map((call) => call.argv).filter((cmd) => cmd[0]?.endsWith("cargo") === true).map((cmd) => cmd.slice(1));
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
    expect(io.captured()).toContain("remove ~/.cargo/bin/wt-sync by hand");
  });

  test("throws when the uninstall fails", () => {
    installCargoCopy();
    stubCargo();
    expect(() => up(context(101))).toThrow(`cargo uninstall ${CRATE} failed`);
  });
});
