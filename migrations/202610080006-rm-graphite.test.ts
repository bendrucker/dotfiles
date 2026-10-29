import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { TAP, up } from "./202610080006-rm-graphite";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("rm-graphite");
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
// `installed` answers `brew list --versions`, and `taps` is what `brew tap` prints.
function stubBrew({ installed = true, taps = [TAP] }: { installed?: boolean; taps?: string[] } = {}): void {
  const printed = taps.map((tap) => `echo ${tap}`).join("\n");
  recordingStub(
    box,
    "brew",
    `[ "$1" = list ] && exit ${installed ? 0 : 1}\n[ "$1" = tap ] && { ${printed || ":"}; exit 0; }\nexit 0`,
  );
  process.env.PATH = `${box.bin}:${path ?? ""}`;
}

describe("rm-graphite", () => {
  test("uninstalls the formula, then untaps", async () => {
    stubBrew();
    await up();
    expect(brewCalls()).toEqual([
      ["list", "--versions", "withgraphite/tap/graphite"],
      ["uninstall", "withgraphite/tap/graphite"],
      ["tap"],
      ["untap", TAP],
    ]);
  });

  test("untaps when the formula is already gone", async () => {
    stubBrew({ installed: false });
    await up();
    expect(brewCalls()).toEqual([["list", "--versions", "withgraphite/tap/graphite"], ["tap"], ["untap", TAP]]);
  });

  test("leaves brew alone when the tap is already gone", async () => {
    stubBrew({ installed: false, taps: ["homebrew/core", "withgraphite/tap-other"] });
    await up();
    expect(brewCalls()).toEqual([["list", "--versions", "withgraphite/tap/graphite"], ["tap"]]);
  });

  test("does nothing on a machine with no brew", async () => {
    process.env.PATH = box.mkdir("empty");
    await up();
    expect(brewCalls()).toEqual([]);
  });
});
