import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ignoresModes, sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202609100001-remove-utc-bar-wispr-flow";

let box: Sandbox;
let home: string;
let installed: string;
let applications: string;

beforeEach(() => {
  box = sandbox("remove-utc-bar-wispr-flow");
  home = box.mkdir("home");
  installed = box.mkdir("installed");
  applications = box.mkdir("Applications");
});

afterEach(() => {
  box.remove();
});

// No brew on PATH, so removeCask returns before it can run anything.
function logged(): string {
  return recorded(box)
    .filter((call) => call[0] === "gum")
    .map((call) => call.at(-1))
    .join("\n");
}

function context(): Context {
  return {
    root: box.dir,
    home,
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications,
    installed: [installed],
    platform: "darwin",
  };
}

async function withoutBrew(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  recordingStub(box, "gum");
  process.env.PATH = box.bin;
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

// The bundle as the App Store leaves it: nothing inside is writable, so
// removing it means unlinking files under a directory the user cannot write.
function bundle(writable: boolean): string {
  const app = join(applications, "UTC Bar.app");
  const contents = join(app, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), "");
  if (!writable) {
    chmodSync(contents, 0o555);
    chmodSync(app, 0o555);
  }
  return app;
}

function restore(app: string): void {
  chmodSync(app, 0o755);
  chmodSync(join(app, "Contents"), 0o755);
}

describe("remove-utc-bar-wispr-flow", () => {
  test("removes the UTC Bar bundle when it can", async () => {
    const app = bundle(true);

    await withoutBrew(() => up(context()));

    expect(exists(app)).toBe(false);
    expect(logged()).toContain("removed");
  });

  // The unwritable bundle is what the OS refuses, and root is refused nothing,
  // so as root the removal would succeed and the case would assert the wrong
  // half. CI runs as an ordinary user, which is where this means something.
  test.skipIf(ignoresModes)("says what to run rather than escalating when the bundle is root's", async () => {
    const app = bundle(false);

    try {
      await withoutBrew(() => up(context()));

      expect(exists(app)).toBe(true);
      expect(logged()).toContain("sudo rm -rf");
    } finally {
      restore(app);
    }
  });

  test("a machine the app is already gone from is quiet", async () => {
    await withoutBrew(() => up(context()));

    expect(logged()).toBe("");
  });

  test("leaves another app in the same directory alone", async () => {
    const other = box.mkdir("Applications", "Ice.app");

    await withoutBrew(() => up(context()));

    expect(exists(other)).toBe(true);
  });
});
