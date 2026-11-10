import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { TOOL, up } from "./202611090001-remove-leaf";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("remove-leaf");
  recordingStub(box, "gum");
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function miseCalls(): string[][] {
  return recorded(box)
    .filter((call) => call[0] === "mise")
    .map((call) => call.slice(1));
}

// The migration resolves mise off PATH, where this puts the stub.
function stubMise(installed: boolean): void {
  const listing = installed ? `echo "${TOOL}  1.28.3"` : "true";
  recordingStub(box, "mise", `[ "$1" = ls ] && { ${listing}; exit 0; }\nexit 0`);
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("remove-leaf", () => {
  test("uninstalls every leaf install and reshims", async () => {
    stubMise(true);
    await up();
    expect(miseCalls()).toEqual([
      ["ls", "--installed", "--no-header", TOOL],
      ["uninstall", "--all", TOOL],
      ["reshim"],
    ]);
  });

  test("does nothing when leaf is not installed", async () => {
    stubMise(false);
    await up();
    expect(miseCalls()).toEqual([["ls", "--installed", "--no-header", TOOL]]);
  });

  test("does nothing on a machine with no mise", async () => {
    process.env.PATH = box.mkdir("empty");
    await up();
    expect(miseCalls()).toEqual([]);
  });
});
