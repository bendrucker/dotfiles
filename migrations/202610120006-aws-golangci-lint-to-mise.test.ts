import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { FORMULAE, up } from "./202610120006-aws-golangci-lint-to-mise";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("aws-golangci-lint-to-mise");
  recordingStub(box, "brew");
  recordingStub(box, "gum");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

describe("aws-golangci-lint-to-mise", () => {
  test("uninstalls each formula a mise pin replaced", async () => {
    await up();
    const uninstalled = recorded(box).filter((call) => call[0] === "brew" && call[1] === "uninstall");
    expect(uninstalled.map((call) => call.at(-1))).toEqual(FORMULAE);
  });
});
