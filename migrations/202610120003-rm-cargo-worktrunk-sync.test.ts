import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { CRATE, up } from "./202610120003-rm-cargo-worktrunk-sync";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("rm-cargo-worktrunk-sync");
  recordingStub(box, "gum");
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("installed")],
    platform: "darwin",
  };
}

function installCargoCopy(): void {
  mkdirSync(box.path("home", ".cargo", "bin"), { recursive: true });
  writeFileSync(box.path("home", ".cargo", "bin", "wt-sync"), "");
}

function cargoCalls(): string[][] {
  return recorded(box)
    .filter((call) => call[0] === "cargo")
    .map((call) => call.slice(1));
}

// The migration resolves cargo off PATH, so a case that wants it found puts a stub there.
function stubCargo(status = 0): void {
  recordingStub(box, "cargo", `exit ${status}`);
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("rm-cargo-worktrunk-sync", () => {
  test("uninstalls the cargo copy", async () => {
    installCargoCopy();
    stubCargo();
    await up(context());
    expect(cargoCalls()).toEqual([["uninstall", CRATE]]);
  });

  test("leaves cargo alone when there is no cargo copy", async () => {
    stubCargo();
    await up(context());
    expect(cargoCalls()).toEqual([]);
  });

  test("warns rather than fails without cargo", async () => {
    installCargoCopy();
    process.env.PATH = box.bin;
    await up(context());
    expect(cargoCalls()).toEqual([]);
    expect(recorded(box).flat().join(" ")).toContain("remove ~/.cargo/bin/wt-sync by hand");
  });

  test("throws when the uninstall fails", async () => {
    installCargoCopy();
    stubCargo(101);
    await expect(up(context())).rejects.toThrow(`cargo uninstall ${CRATE} failed`);
  });
});
