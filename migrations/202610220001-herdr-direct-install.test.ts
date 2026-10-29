import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";
import type { Context } from "#migrations/migration";
import { exists } from "#migrations/migration";
import { up } from "./202610220001-herdr-direct-install";

let box: Sandbox;

interface Reply {
  status: number;
  stdout: string;
}

// Keyed by the tool and its first argument, as in "brew list".
let replies: Record<string, Reply>;

beforeEach(() => {
  box = sandbox("herdr-direct-install");
  box.mkdir("home");
  replies = {};
});

afterEach(() => {
  box.remove();
});

const plist = () => box.path("home", "Library", "LaunchAgents", "me.bendrucker.herdr.plist");

function context(platform: Context["platform"] = "darwin"): Context {
  return {
    root: box.dir,
    home: box.path("home"),
    config: box.path("home", ".config"),
    data: box.path("home", ".local", "share"),
    applications: box.path("Applications"),
    installed: [box.path("dotfiles")],
    platform,
  };
}

// What a probe answers when no reply was set: absent, as on a machine without it.
const PROBES = ["print", "list", "--prefix", "-A"];

function stubTool(tool: string): void {
  const answers = Object.entries(replies)
    .filter(([key]) => key.startsWith(`${tool} `))
    .map(([key, reply]) => `[ "$1" = '${key.split(" ")[1]}' ] && { printf '%s' '${reply.stdout}'; exit ${reply.status}; }`);
  const fallback = PROBES.map((probe) => `[ "$1" = '${probe}' ]`).join(" || ");
  recordingStub(box, tool, `${answers.join("\n")}\nif ${fallback}; then exit 1; fi\nexit 0`);
}

async function withBrew(body: () => Promise<void>): Promise<void> {
  for (const tool of ["brew", "launchctl", "ps", "gum"]) stubTool(tool);
  const path = process.env.PATH;
  process.env.PATH = box.bin;
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

const ran = () => recorded(box).map((call) => call.slice(0, 2).join(" "));

function brewHerdr(): void {
  replies["brew list"] = { status: 0, stdout: "herdr 0.9.5\n" };
  replies["brew --prefix"] = { status: 0, stdout: "/opt/homebrew\n" };
}

describe("herdr-direct-install", () => {
  test("boots out an idle agent and removes its plist", async () => {
    box.write("home/Library/LaunchAgents/me.bendrucker.herdr.plist", "<plist/>\n");
    replies["launchctl print"] = { status: 0, stdout: "\tstate = not running\n" };

    await withBrew(() => up(context()));

    expect(ran()).toContain("launchctl bootout");
    expect(exists(plist())).toBe(false);
  });

  test("leaves an agent alone while it runs the live server", async () => {
    box.write("home/Library/LaunchAgents/me.bendrucker.herdr.plist", "<plist/>\n");
    replies["launchctl print"] = { status: 0, stdout: "\tstate = running\n\tpid = 4242\n" };

    await expect(withBrew(() => up(context()))).rejects.toThrow(/still runs under launchd/);
    expect(ran()).not.toContain("launchctl bootout");
    expect(exists(plist())).toBe(true);
  });

  test("keeps Homebrew's herdr until the direct install exists", async () => {
    brewHerdr();

    await expect(withBrew(() => up(context()))).rejects.toThrow(/not installed yet/);
    expect(ran()).not.toContain("brew uninstall");
  });

  test("keeps Homebrew's herdr while a server runs from it", async () => {
    brewHerdr();
    box.write("home/.local/bin/herdr", "");
    replies["ps -A"] = { status: 0, stdout: "/opt/homebrew/bin/herdr server\n/bin/zsh -l\n" };

    await expect(withBrew(() => up(context()))).rejects.toThrow(/running from Homebrew's binary/);
    expect(ran()).not.toContain("brew uninstall");
  });

  test("uninstalls Homebrew's herdr once the server runs the direct install", async () => {
    brewHerdr();
    box.write("home/.local/bin/herdr", "");
    replies["ps -A"] = { status: 0, stdout: `${box.path("home", ".local", "bin", "herdr")} server --handoff-import x y\n` };

    await withBrew(() => up(context()));

    expect(ran()).toContain("brew uninstall");
  });

  test("touches no launchd job on Linux", async () => {
    await withBrew(() => up(context("linux")));

    expect(ran().filter((call) => call.startsWith("launchctl "))).toEqual([]);
    expect(ran()).not.toContain("brew uninstall");
  });
});
