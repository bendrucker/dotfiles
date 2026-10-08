import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { FORMULAE, up } from "./202610080001-pin-cli-tools-in-mise";

let box: Sandbox;
let commands: string[][];
const path = process.env.PATH;

beforeEach(() => {
  box = sandbox("pin-cli-tools-in-mise");
  commands = [];
  box.stub("brew", "exit 0");
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(uninstall: (name: string) => number = () => 0): Context {
  return {
    root: box.dir,
    home: box.mkdir("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    out: {
      write() {},
      run(cmd) {
        commands.push(cmd);
        return cmd[1] === "uninstall" ? uninstall(cmd.at(-1) ?? "") : 0;
      },
      read: () => ({ status: 0, stdout: "" }),
    },
  };
}

function uninstalled(): string[] {
  return commands.filter((cmd) => cmd[1] === "uninstall").map((cmd) => cmd.at(-1) ?? "");
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
    up(context((name) => (name === "jq" ? 1 : 0)));

    expect(uninstalled()).toEqual(FORMULAE);
    const warnings = commands.filter((cmd) => cmd[0] === "gum" && cmd.includes("warn"));
    expect(warnings.map((cmd) => cmd.at(-1))).toEqual(["kept jq: brew uninstall jq failed"]);
  });
});
