import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import type { CommandResult } from "#jobs/output";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202610220001-herdr-direct-install";

let box: Sandbox;
let ran: string[];
let replies: Record<string, CommandResult>;

beforeEach(() => {
  box = sandbox("herdr-direct-install");
  box.mkdir("home");
  box.stub("brew", "exit 0");
  ran = [];
  replies = {};
});

afterEach(() => {
  box.remove();
});

const plist = () => box.path("home", "Library", "LaunchAgents", "me.bendrucker.herdr.plist");

// The command's first two words, by tool name.
function key(cmd: string[]): string {
  return cmd
    .slice(0, 2)
    .map((word) => word.split("/").at(-1))
    .join(" ");
}

function context(platform: Context["platform"] = "darwin"): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("dotfiles")],
    platform,
    out: {
      write() {},
      run(cmd) {
        ran.push(key(cmd));
        return 0;
      },
      read: (cmd) => replies[key(cmd)] ?? { status: 1, stdout: "" },
    },
  };
}

function withBrew(body: () => void): void {
  const path = process.env.PATH;
  process.env.PATH = box.bin;
  try {
    body();
  } finally {
    process.env.PATH = path;
  }
}

function brewHerdr(): void {
  replies["brew list"] = { status: 0, stdout: "herdr 0.9.5\n" };
  replies["brew --prefix"] = { status: 0, stdout: "/opt/homebrew\n" };
}

describe("herdr-direct-install", () => {
  test("boots out an idle agent and removes its plist", () => {
    box.write("home/Library/LaunchAgents/me.bendrucker.herdr.plist", "<plist/>\n");
    replies["launchctl print"] = { status: 0, stdout: "\tstate = not running\n" };

    withBrew(() => up(context()));

    expect(ran).toContain("launchctl bootout");
    expect(exists(plist())).toBe(false);
  });

  test("leaves an agent alone while it runs the live server", () => {
    box.write("home/Library/LaunchAgents/me.bendrucker.herdr.plist", "<plist/>\n");
    replies["launchctl print"] = { status: 0, stdout: "\tstate = running\n\tpid = 4242\n" };

    expect(() => withBrew(() => up(context()))).toThrow(/still runs under launchd/);
    expect(ran).not.toContain("launchctl bootout");
    expect(exists(plist())).toBe(true);
  });

  test("keeps Homebrew's herdr until the direct install exists", () => {
    brewHerdr();

    expect(() => withBrew(() => up(context()))).toThrow(/not installed yet/);
    expect(ran).not.toContain("brew uninstall");
  });

  test("keeps Homebrew's herdr while a server runs from it", () => {
    brewHerdr();
    box.write("home/.local/bin/herdr", "");
    replies["ps -A"] = { status: 0, stdout: "/opt/homebrew/bin/herdr server\n/bin/zsh -l\n" };

    expect(() => withBrew(() => up(context()))).toThrow(/running from Homebrew's binary/);
    expect(ran).not.toContain("brew uninstall");
  });

  test("uninstalls Homebrew's herdr once the server runs the direct install", () => {
    brewHerdr();
    box.write("home/.local/bin/herdr", "");
    replies["ps -A"] = { status: 0, stdout: `${box.path("home", ".local", "bin", "herdr")} server --handoff-import x y\n` };

    withBrew(() => up(context()));

    expect(ran).toContain("brew uninstall");
  });

  test("touches no launchd job on Linux", () => {
    withBrew(() => up(context("linux")));

    expect(ran).toEqual([]);
  });
});
