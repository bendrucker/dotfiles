import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { RETIRED, up } from "./202610080001-launchd-agents-to-mise";

let box: Sandbox;
let launchctl: string[][];

beforeEach(() => {
  box = sandbox("launchd-agents-to-mise");
  box.mkdir("home", "Library", "LaunchAgents");
  launchctl = [];
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
    installed: [box.mkdir("installed")],
    platform: "darwin",
    out: {
      write() {},
      run: () => 0,
      read(cmd) {
        if (cmd[0] === "launchctl") launchctl.push(cmd.slice(1, 2));
        return { status: 0, stdout: "" };
      },
    },
  };
}

function plist(label: string): string {
  return join(box.path("home", "Library", "LaunchAgents"), `${label}.plist`);
}

describe("launchd-agents-to-mise", () => {
  test("boots out and removes every retired agent", () => {
    for (const label of RETIRED) box.write(`home/Library/LaunchAgents/${label}.plist`, "");

    up(context());

    for (const label of RETIRED) expect(exists(plist(label))).toBe(false);
    expect(launchctl).toEqual(RETIRED.map(() => ["bootout"]));
  });

  // The nightly job runs this migration, and nothing replaces it until
  // macos/install.sh has loaded dev.mise.dotfiles-upgrade. Retiring it here
  // would leave no nightly job if the install failed in between.
  test("leaves the nightly job for macos/install.sh to retire", () => {
    box.write("home/Library/LaunchAgents/com.user.dotfiles-upgrade.plist", "");

    up(context());

    expect(exists(plist("com.user.dotfiles-upgrade"))).toBe(true);
  });

  test("leaves the agents mise installed alone", () => {
    box.write("home/Library/LaunchAgents/dev.mise.theme-sync.plist", "");

    up(context());

    expect(exists(plist("dev.mise.theme-sync"))).toBe(true);
  });
});
