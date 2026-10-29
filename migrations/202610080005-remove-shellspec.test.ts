import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { up } from "./202610080005-remove-shellspec";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("remove-shellspec");
  recordingStub(box, "brew");
  recordingStub(box, "gum");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

describe("remove-shellspec", () => {
  test("uninstalls the formula no Brewfile declares any more", async () => {
    await up();
    expect(recorded(box).filter((call) => call[0] === "brew").map((call) => call.slice(1))).toEqual([
      ["list", "--versions", "shellspec"],
      ["uninstall", "shellspec"],
    ]);
  });
});
