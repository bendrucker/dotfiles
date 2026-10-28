import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FakeIo, fakeIo, sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { FORMULAE, up } from "./202610080002-pin-cli-tools-in-mise";

let box: Sandbox;
let io: FakeIo;
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("pin-cli-tools-in-mise");
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

// Every brew command succeeds except an uninstall of a formula in `refused`.
function context(refused: string[] = []): Context {
  const brew = join(box.bin, "brew");
  io = fakeIo({
    answers: [...refused.map((name) => ({ argv: [brew, "uninstall", name], status: 1 })), { argv: [] }],
  });
  return {
    root: box.dir,
    home: box.mkdir("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    io,
  };
}

function uninstalled(): string[] {
  return io.calls.filter((call) => call.argv[1] === "uninstall").map((call) => call.argv.at(-1) ?? "");
}

describe("pin-cli-tools-in-mise", () => {
  test("uninstalls every formula system/mise.toml now pins", () => {
    up(context());
    expect(uninstalled()).toEqual(FORMULAE);
  });

  test("uninstalls actionlint before the shellcheck it depends on", () => {
    up(context());
    expect(uninstalled().indexOf("actionlint")).toBeLessThan(uninstalled().indexOf("shellcheck"));
  });

  test("keeps a formula brew refuses to remove and carries on with the rest", () => {
    up(context(["jq"]));

    expect(uninstalled()).toEqual(FORMULAE);
    const warnings = io.logs.filter((line) => line.level === "warn");
    expect(warnings.map((line) => line.message)).toEqual(["kept jq: brew uninstall jq failed"]);
  });
});
