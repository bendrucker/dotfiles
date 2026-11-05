import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { FORMULA, up } from "./202611040002-hcledit-full-name";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("hcledit-full-name");
  recordingStub(box, "gum");
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function brewCalls(): string[][] {
  return recorded(box)
    .filter((call) => call[0] === "brew")
    .map((call) => call.slice(1));
}

// The migration resolves brew off PATH, where this puts the stub.
function stubBrew(installed: boolean): void {
  recordingStub(box, "brew", `[ "$1" = list ] && exit ${installed ? 0 : 1}\nexit 0`);
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("hcledit-full-name", () => {
  test("installs the tap's hcledit when cleanup removed it", async () => {
    stubBrew(false);
    await up();
    expect(brewCalls()).toEqual([
      ["list", "--versions", "hcledit"],
      ["install", "--formula", FORMULA],
    ]);
  });

  test("leaves an installed hcledit alone", async () => {
    stubBrew(true);
    await up();
    expect(brewCalls()).toEqual([["list", "--versions", "hcledit"]]);
  });

  test("does nothing on a machine with no brew", async () => {
    process.env.PATH = box.mkdir("empty");
    await up();
    expect(brewCalls()).toEqual([]);
  });
});
