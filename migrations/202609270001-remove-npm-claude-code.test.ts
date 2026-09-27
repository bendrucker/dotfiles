import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202609270001-remove-npm-claude-code";

let box: Sandbox;
let home: string;
let ran: string[][];
let reshimStatus: number;

beforeEach(() => {
  box = sandbox("remove-npm-claude-code");
  home = box.mkdir("home");
  ran = [];
  reshimStatus = 0;
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
    out: {
      write() {},
      run(cmd) {
        ran.push(cmd);
        return cmd.at(-1) === "reshim" ? reshimStatus : 0;
      },
      read: () => ({ status: 1, stdout: "" }),
    },
  };
}

const MISE = join("home", ".local", "share", "mise");

function mise(...parts: string[]): string {
  return box.path(MISE, ...parts);
}

function npmInstall(version: string): string {
  const install = join(MISE, "installs", "node", version);
  box.write(join(install, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "");
  box.mkdir(install, "bin");
  symlinkSync("../lib/node_modules/@anthropic-ai/claude-code/cli.js", box.path(install, "bin", "claude"));
  return box.path(install);
}

function staleShim(): void {
  box.mkdir(MISE, "shims");
  symlinkSync("/opt/homebrew/bin/mise", mise("shims", "claude"));
}

function withPath(path: string, body: () => void): void {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    body();
  } finally {
    process.env.PATH = saved;
  }
}

function reshims(): string[][] {
  return ran.filter((cmd) => cmd.at(-1) === "reshim");
}

describe("remove-npm-claude-code", () => {
  test("removes the package and the bin link npm made", () => {
    const install = npmInstall("20.11.1");

    withPath("", () => up(context()));

    expect(exists(join(install, "bin", "claude"))).toBe(false);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai"))).toBe(false);
  });

  test("keeps the node version and the rest of its globals", () => {
    const install = npmInstall("20.11.1");
    box.write(join(MISE, "installs", "node", "20.11.1", "bin", "node"), "");
    box.write(join(MISE, "installs", "node", "20.11.1", "lib", "node_modules", "@anthropic-ai", "sdk", "index.js"), "");

    withPath("", () => up(context()));

    expect(exists(join(install, "bin", "node"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai", "sdk"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai", "claude-code"))).toBe(false);
  });

  test("finishes what an interrupted run left behind", () => {
    const install = npmInstall("20.11.1");
    rmSync(join(install, "lib", "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });

    withPath("", () => up(context()));

    expect(exists(join(install, "bin", "claude"))).toBe(false);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai"))).toBe(false);
  });

  test("throws when the installs directory exists but cannot be read", () => {
    box.write(join(MISE, "installs", "node"), "");

    expect(() => withPath("", () => up(context()))).toThrow();
  });

  test("reaches every installed version and skips the alias links", () => {
    const old = npmInstall("20.11.1");
    const other = npmInstall("22.14.0");
    symlinkSync("./20.11.1", mise("installs", "node", "lts-iron"));

    withPath("", () => up(context()));

    expect(exists(join(old, "bin", "claude"))).toBe(false);
    expect(exists(join(other, "bin", "claude"))).toBe(false);
    expect(exists(mise("installs", "node", "lts-iron"))).toBe(true);
  });

  test("leaves a claude in bin that npm did not link to the package", () => {
    const install = npmInstall("20.11.1");
    const bin = join(install, "bin", "claude");
    rmSync(bin);
    writeFileSync(bin, "#!/bin/sh\n");

    withPath("", () => up(context()));

    expect(exists(bin)).toBe(true);
  });

  test("reshims while the stale shim is there", () => {
    npmInstall("20.11.1");
    staleShim();
    const stub = box.stub("mise", "");

    withPath(box.bin, () => up(context()));

    expect(reshims()).toEqual([[stub, "reshim"]]);
  });

  test("reshims a shim left behind after the package is already gone", () => {
    staleShim();
    box.stub("mise", "");

    withPath(box.bin, () => up(context()));

    expect(reshims()).toHaveLength(1);
  });

  test("does not reshim without a claude shim", () => {
    npmInstall("20.11.1");
    box.stub("mise", "");

    withPath(box.bin, () => up(context()));

    expect(reshims()).toEqual([]);
  });

  test("throws when reshim fails, so the next run retries it", () => {
    staleShim();
    box.stub("mise", "");
    reshimStatus = 1;

    expect(() => withPath(box.bin, () => up(context()))).toThrow("mise reshim failed");
  });

  test("a machine without mise is not an error", () => {
    npmInstall("20.11.1");
    staleShim();

    expect(() => withPath("", () => up(context()))).not.toThrow();
    expect(reshims()).toEqual([]);
  });

  test("a machine with no node installs is not an error", () => {
    expect(() => withPath("", () => up(context()))).not.toThrow();
  });
});
