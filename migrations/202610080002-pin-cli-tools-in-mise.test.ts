import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import { FORMULAE, up } from "./202610080002-pin-cli-tools-in-mise";

let box: Sandbox;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("pin-cli-tools-in-mise");
  recordingStub(box, "gum");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

// `refused` names a formula brew will not uninstall.
function stubBrew(refused?: string): void {
  recordingStub(box, "brew", refused === undefined ? "" : `[ "$1" = uninstall ] && [ "$2" = ${refused} ] && exit 1
exit 0`);
}

function uninstalled(): string[] {
  return recorded(box)
    .filter((call) => call[0] === "brew" && call[1] === "uninstall")
    .map((call) => call.at(-1) ?? "");
}

describe("pin-cli-tools-in-mise", () => {
  test("uninstalls every formula system/mise.toml now pins", async () => {
    stubBrew();
    await up();
    expect(uninstalled()).toEqual(FORMULAE);
  });

  test("uninstalls actionlint before the shellcheck it depends on", async () => {
    stubBrew();
    await up();
    expect(uninstalled().indexOf("actionlint")).toBeLessThan(uninstalled().indexOf("shellcheck"));
  });

  test("keeps a formula brew refuses to remove and carries on with the rest", async () => {
    stubBrew("jq");
    await up();

    expect(uninstalled()).toEqual(FORMULAE);
    const warnings = recorded(box).filter((call) => call[0] === "gum" && call.includes("warn"));
    expect(warnings.map((call) => call.at(-1))).toEqual(["kept jq: brew uninstall jq failed"]);
  });
});
