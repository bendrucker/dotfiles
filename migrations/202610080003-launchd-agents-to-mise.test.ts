import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { RETIRED, up } from "./202610080003-launchd-agents-to-mise";

let box: Sandbox;
let path: string | undefined;

beforeEach(() => {
  box = sandbox("launchd-agents-to-mise");
  box.mkdir("home", "Library", "LaunchAgents");
  recordingStub(box, "launchctl");
  recordingStub(box, "gum");
  path = process.env.PATH;
  process.env.PATH = `${box.bin}:${path ?? ""}`;
});

afterEach(() => {
  process.env.PATH = path;
  box.remove();
});

function context(): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.mkdir("Applications"),
    installed: [box.mkdir("installed")],
    platform: "darwin",
  };
}

function plist(label: string): string {
  return join(box.path("home", "Library", "LaunchAgents"), `${label}.plist`);
}

describe("launchd-agents-to-mise", () => {
  test("boots out and removes every retired agent", async () => {
    for (const label of RETIRED) box.write(`home/Library/LaunchAgents/${label}.plist`, "");

    await up(context());

    for (const label of RETIRED) expect(exists(plist(label))).toBe(false);
    const bootouts = recorded(box).filter((call) => call[0] === "launchctl");
    expect(bootouts.map((call) => call[1])).toEqual(RETIRED.map(() => "bootout"));
  });

  // The nightly job runs this migration, and nothing replaces it until
  // macos/install.sh has loaded dev.mise.dotfiles-upgrade. Retiring it here
  // would leave no nightly job if the install failed in between.
  test("leaves the nightly job for macos/install.sh to retire", async () => {
    box.write("home/Library/LaunchAgents/com.user.dotfiles-upgrade.plist", "");

    await up(context());

    expect(exists(plist("com.user.dotfiles-upgrade"))).toBe(true);
  });

  test("leaves the agents mise installed alone", async () => {
    box.write("home/Library/LaunchAgents/dev.mise.theme-sync.plist", "");

    await up(context());

    expect(exists(plist("dev.mise.theme-sync"))).toBe(true);
  });
});
