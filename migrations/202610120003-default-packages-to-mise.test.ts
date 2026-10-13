import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202610120003-default-packages-to-mise";

let box: Sandbox;
let home: string;

beforeEach(() => {
  box = sandbox("default-packages-to-mise");
  home = box.mkdir("home");
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
    out: { write() {}, run: () => 0, read: () => ({ status: 1, stdout: "" }) },
  };
}

const NODE = join("home", ".local", "share", "mise", "installs", "node");

// What `npm i -g <name>` leaves in a mise node: the package, and a relative
// link in bin to each of its executables.
function npmGlobal(version: string, name: string, bins: string[]): string {
  const install = join(NODE, version);
  box.write(join(install, "lib", "node_modules", name, "package.json"), "{}");
  box.mkdir(install, "bin");
  for (const bin of bins) {
    symlinkSync(`../lib/node_modules/${name}/bin/${bin}`, box.path(install, "bin", bin));
  }
  return box.path(install);
}

describe("default-packages-to-mise", () => {
  test.each<{ name: string; list: string; content: string; kept: boolean }>([
    { name: "removes the generated npm list", list: ".default-npm-packages", content: "# Auto-generated from dotfiles - do not edit directly\ntypescript\n", kept: false },
    { name: "removes the generated go list", list: ".default-go-packages", content: "# Auto-generated from dotfiles - do not edit directly\ngithub.com/spf13/cobra-cli\n", kept: false },
    { name: "leaves a list someone wrote by hand", list: ".default-npm-packages", content: "prettier\n", kept: true },
  ])("$name", ({ list, content, kept }) => {
    const path = box.write(join("home", list), content);

    up(context());

    expect(exists(path)).toBe(kept);
  });

  test("removes each package and the bin links npm made into it", () => {
    const install = npmGlobal("24.21.0", "typescript", ["tsc", "tsserver"]);
    npmGlobal("24.21.0", "@modelcontextprotocol/inspector", ["mcp-inspector"]);

    up(context());

    for (const bin of ["tsc", "tsserver", "mcp-inspector"]) {
      expect(exists(join(install, "bin", bin))).toBe(false);
    }
    expect(exists(join(install, "lib", "node_modules", "typescript"))).toBe(false);
    expect(exists(join(install, "lib", "node_modules", "@modelcontextprotocol"))).toBe(false);
  });

  test("keeps the node version and every other global", () => {
    const install = npmGlobal("24.21.0", "ccusage", ["ccusage"]);
    npmGlobal("24.21.0", "prettier", ["prettier"]);
    box.write(join(NODE, "24.21.0", "bin", "node"), "");
    box.write(join(NODE, "24.21.0", "lib", "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "{}");

    up(context());

    expect(exists(join(install, "bin", "node"))).toBe(true);
    expect(exists(join(install, "bin", "prettier"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "prettier"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "@modelcontextprotocol", "sdk"))).toBe(true);
    expect(exists(join(install, "bin", "ccusage"))).toBe(false);
  });

  test("leaves a bin of the same name that npm did not link into the package", () => {
    const install = npmGlobal("24.21.0", "typescript", []);
    const tsc = box.write(join(NODE, "24.21.0", "bin", "tsc"), "#!/bin/sh\n");

    up(context());

    expect(exists(tsc)).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "typescript"))).toBe(false);
  });

  test("reaches every installed version and skips the alias links", () => {
    const current = npmGlobal("24.21.0", "typescript", ["tsc"]);
    const old = npmGlobal("22.14.0", "typescript", ["tsc"]);
    symlinkSync("./24.21.0", box.path(NODE, "24"));

    up(context());

    expect(exists(join(current, "bin", "tsc"))).toBe(false);
    expect(exists(join(old, "bin", "tsc"))).toBe(false);
    expect(exists(box.path(NODE, "24"))).toBe(true);
  });

  test("throws when the installs directory exists but cannot be read", () => {
    box.write(NODE, "");

    expect(() => up(context())).toThrow();
  });

  test("a machine with nothing to clean up is not an error", () => {
    expect(() => up(context())).not.toThrow();
  });
});
