import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202609270001-remove-npm-claude-code";

let box: Sandbox;
let home: string;

beforeEach(() => {
  box = sandbox("remove-npm-claude-code");
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

async function withPath(path: string, body: () => Promise<void>): Promise<void> {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    await body();
  } finally {
    process.env.PATH = saved;
  }
}

function reshims(): string[][] {
  return recorded(box).filter((call) => call[0] === "mise");
}

describe("remove-npm-claude-code", () => {
  test("removes the package and the bin link npm made", async () => {
    const install = npmInstall("20.11.1");

    await withPath("", () => up(context()));

    expect(exists(join(install, "bin", "claude"))).toBe(false);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai"))).toBe(false);
  });

  test("keeps the node version and the rest of its globals", async () => {
    const install = npmInstall("20.11.1");
    box.write(join(MISE, "installs", "node", "20.11.1", "bin", "node"), "");
    box.write(join(MISE, "installs", "node", "20.11.1", "lib", "node_modules", "@anthropic-ai", "sdk", "index.js"), "");

    await withPath("", () => up(context()));

    expect(exists(join(install, "bin", "node"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai", "sdk"))).toBe(true);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai", "claude-code"))).toBe(false);
  });

  test("finishes what an interrupted run left behind", async () => {
    const install = npmInstall("20.11.1");
    rmSync(join(install, "lib", "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });

    await withPath("", () => up(context()));

    expect(exists(join(install, "bin", "claude"))).toBe(false);
    expect(exists(join(install, "lib", "node_modules", "@anthropic-ai"))).toBe(false);
  });

  test("throws when the installs directory exists but cannot be read", async () => {
    box.write(join(MISE, "installs", "node"), "");

    await expect(withPath("", () => up(context()))).rejects.toThrow();
  });

  test("reaches every installed version and skips the alias links", async () => {
    const old = npmInstall("20.11.1");
    const other = npmInstall("22.14.0");
    symlinkSync("./20.11.1", mise("installs", "node", "lts-iron"));

    await withPath("", () => up(context()));

    expect(exists(join(old, "bin", "claude"))).toBe(false);
    expect(exists(join(other, "bin", "claude"))).toBe(false);
    expect(exists(mise("installs", "node", "lts-iron"))).toBe(true);
  });

  test("leaves a claude in bin that npm did not link to the package", async () => {
    const install = npmInstall("20.11.1");
    const bin = join(install, "bin", "claude");
    rmSync(bin);
    writeFileSync(bin, "#!/bin/sh\n");

    await withPath("", () => up(context()));

    expect(exists(bin)).toBe(true);
  });

  test("reshims while the stale shim is there", async () => {
    npmInstall("20.11.1");
    staleShim();
    recordingStub(box, "mise");

    await withPath(box.bin, () => up(context()));

    expect(reshims()).toEqual([["mise", "reshim"]]);
  });

  test("reshims a shim left behind after the package is already gone", async () => {
    staleShim();
    recordingStub(box, "mise");

    await withPath(box.bin, () => up(context()));

    expect(reshims()).toHaveLength(1);
  });

  test("does not reshim without a claude shim", async () => {
    npmInstall("20.11.1");
    recordingStub(box, "mise");

    await withPath(box.bin, () => up(context()));

    expect(reshims()).toEqual([]);
  });

  test("throws when reshim fails, so the next run retries it", async () => {
    staleShim();
    recordingStub(box, "mise", "exit 1");

    await expect(withPath(box.bin, () => up(context()))).rejects.toThrow("mise reshim failed");
  });

  test("a machine without mise is not an error", async () => {
    npmInstall("20.11.1");
    staleShim();

    await expect(withPath("", () => up(context()))).resolves.toBeUndefined();
    expect(reshims()).toEqual([]);
  });

  test("a machine with no node installs is not an error", async () => {
    await expect(withPath("", () => up(context()))).resolves.toBeUndefined();
  });
});
