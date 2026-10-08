import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sandbox, type Sandbox } from "#harness";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { RETIRED, RUNNING_JOB, up } from "./202610080001-launchd-agents-to-mise";

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
  test("removes every retired plist, the running job's included", () => {
    for (const label of [...RETIRED, RUNNING_JOB]) box.write(`home/Library/LaunchAgents/${label}.plist`, "");

    up(context());

    for (const label of [...RETIRED, RUNNING_JOB]) expect(exists(plist(label))).toBe(false);
  });

  test("disables the job that runs migrations rather than booting it out", () => {
    up(context());

    expect(launchctl).toEqual([...RETIRED.map(() => ["bootout"]), ["disable"]]);
  });

  test("leaves the agents mise installed alone", () => {
    box.write("home/Library/LaunchAgents/dev.mise.theme-sync.plist", "");

    up(context());

    expect(exists(plist("dev.mise.theme-sync"))).toBe(true);
  });
});
