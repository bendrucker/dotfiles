import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { AGENTS, LINKS, up } from "./202610080004-remove-activitywatch";

let box: Sandbox;
let installed: string;

beforeEach(() => {
  box = sandbox("remove-activitywatch");
  box.mkdir("home", "Library", "LaunchAgents");
  installed = box.mkdir("installed");
});

afterEach(() => {
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.mkdir("Applications"),
    installed: [installed],
    platform: "darwin",
  };
}

// No brew or uv on PATH, so the package removals return before running anything.
async function withoutTools(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  recordingStub(box, "launchctl");
  recordingStub(box, "gum");
  process.env.PATH = box.bin;
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

function support(...parts: string[]): string {
  return box.path("home", "Library", "Application Support", "activitywatch", ...parts);
}

describe("remove-activitywatch", () => {
  test("boots out and removes both agents", async () => {
    for (const label of AGENTS) box.write(`home/Library/LaunchAgents/${label}.plist`, "");

    await withoutTools(() => up(context()));

    for (const label of AGENTS) {
      expect(exists(box.path("home", "Library", "LaunchAgents", `${label}.plist`))).toBe(false);
    }
    const bootouts = recorded(box).filter((call) => call[0] === "launchctl");
    expect(bootouts.map((call) => call[2]?.split("/").at(-1))).toEqual(AGENTS);
  });

  test("removes the config links and keeps the captured data", async () => {
    for (const link of LINKS) {
      box.mkdir("home", "Library", "Application Support", "activitywatch", join(link, ".."));
      symlinkSync(join(installed, "activitywatch", link), support(link));
    }
    box.write("home/Library/Application Support/activitywatch/aw-server-rust/sqlite.db", "");

    await withoutTools(() => up(context()));

    for (const link of LINKS) expect(exists(support(link))).toBe(false);
    expect(exists(support("aw-server-rust", "sqlite.db"))).toBe(true);
  });

  test("leaves a config file someone wrote in place of the link", async () => {
    box.write("home/Library/Application Support/activitywatch/aw-qt/aw-qt.toml", "");

    await withoutTools(() => up(context()));

    expect(exists(support("aw-qt", "aw-qt.toml"))).toBe(true);
  });
});
