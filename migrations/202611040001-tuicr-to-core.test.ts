import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { TAP, up } from "./202611040001-tuicr-to-core";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("tuicr-to-core");
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

// The migration resolves brew off PATH, so a case that wants it found puts a stub there.
function stubBrew(): void {
  const cellar = box.mkdir("Cellar");
  recordingStub(box, "brew", `[ "$1" = --cellar ] && echo ${cellar}\nexit 0`);
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

function receipt(tap: string | null): void {
  box.write("Cellar/tuicr/0.28.0/INSTALL_RECEIPT.json", JSON.stringify({ source: { tap } }));
}

describe("tuicr-to-core", () => {
  test("replaces a keg installed from the tap with core's", async () => {
    stubBrew();
    receipt(TAP);
    await up();
    expect(brewCalls()).toEqual([
      ["--cellar"],
      ["uninstall", "--formula", "tuicr"],
      ["install", "--formula", "tuicr"],
    ]);
  });

  test.each<{ name: string; tap: string | null | undefined }>([
    { name: "core's keg", tap: "homebrew/core" },
    { name: "a receipt with no tap", tap: null },
    { name: "no tuicr at all", tap: undefined },
  ])("leaves $name alone", async ({ tap }) => {
    stubBrew();
    if (tap !== undefined) receipt(tap);
    await up();
    expect(brewCalls()).toEqual([["--cellar"]]);
  });

  test("does nothing on a machine with no brew", async () => {
    process.env.PATH = box.mkdir("empty");
    await up();
    expect(brewCalls()).toEqual([]);
  });
});
