import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { TAP, up } from "./202611040001-tuicr-to-core";

let box: Sandbox;
const path = process.env.PATH;
const tapFormula = `${TAP}/tuicr`;

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
// `installed` lists the formulae `brew list --versions` answers for, and `taps` is what `brew tap` prints.
function stubBrew({ installed = [tapFormula], taps = [TAP] }: { installed?: string[]; taps?: string[] } = {}): void {
  const listed = installed.map((name) => `[ "$3" = ${name} ] && exit 0`).join("\n");
  const printed = taps.map((tap) => `echo ${tap}`).join("\n");
  recordingStub(
    box,
    "brew",
    `if [ "$1" = list ]; then\n${listed || ":"}\nexit 1\nfi\n[ "$1" = tap ] && { ${printed || ":"}; exit 0; }\nexit 0`,
  );
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("tuicr-to-core", () => {
  test("uninstalls the tap formula, untaps, then installs core's", async () => {
    stubBrew();
    await up();
    expect(brewCalls()).toEqual([
      ["list", "--versions", tapFormula],
      ["uninstall", tapFormula],
      ["tap"],
      ["untap", TAP],
      ["list", "--versions", "tuicr"],
      ["install", "tuicr"],
    ]);
  });

  test("untaps when the formula is already gone", async () => {
    stubBrew({ installed: ["tuicr"] });
    await up();
    expect(brewCalls()).toEqual([
      ["list", "--versions", tapFormula],
      ["tap"],
      ["untap", TAP],
      ["list", "--versions", "tuicr"],
    ]);
  });

  test("leaves brew alone when core's tuicr is already installed and the tap is gone", async () => {
    stubBrew({ installed: ["tuicr"], taps: ["homebrew/core", "agavra/tap-other"] });
    await up();
    expect(brewCalls()).toEqual([
      ["list", "--versions", tapFormula],
      ["tap"],
      ["list", "--versions", "tuicr"],
    ]);
  });

  test("does nothing on a machine with no brew", async () => {
    process.env.PATH = box.mkdir("empty");
    await up();
    expect(brewCalls()).toEqual([]);
  });
});
