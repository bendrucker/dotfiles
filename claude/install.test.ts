import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, sandbox, shell, type Sandbox } from "#harness";

const install = join(repoRoot, "claude", "install.sh");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("claude-install");
  for (const file of [
    "user/settings.json",
    "user/CLAUDE.md",
    "user/skills/ship/SKILL.md",
    "platforms/local/platform.md",
    "platforms/remote/platform.md",
    "platforms/remote/settings.json",
  ])
    box.write(`repo/${file}`, "");
  box.mkdir(".claude");
});

afterEach(() => {
  box.remove();
});

function call(fn: string, env: Record<string, string> = {}) {
  return shell(`. "$1" && ${fn}`, {
    args: [install],
    env: { HOME: box.dir, CLAUDE_REPO_HOME: box.path("repo"), CLAUDE_MANAGED_DIR: box.path("managed"), ...env },
  });
}

describe("install_claude_symlinks", () => {
  test.each([
    {
      platform: "local",
      links: { "settings.json": "user/settings.json", "CLAUDE.md": "user/CLAUDE.md", "platform.md": "platforms/local/platform.md", skills: "user/skills" },
    },
    {
      platform: "remote",
      links: { "settings.json": "platforms/remote/settings.json", "CLAUDE.md": "user/CLAUDE.md", "platform.md": "platforms/remote/platform.md", skills: "user/skills" },
    },
    {
      platform: "remote",
      existing: true,
      links: { "skills/ship": "user/skills/ship", "platform.md": "platforms/remote/platform.md" },
    },
  ])("$platform, skills directory existing: $existing", ({ platform, existing, links }) => {
    if (existing) {
      box.mkdir(".claude", "skills", "synced");
      symlinkSync(box.path("repo/user/skills/gone"), box.path(".claude/skills/gone"));
    }

    expect(call(`install_claude_symlinks ${platform}`).status).toBe(0);

    for (const [target, source] of Object.entries(links))
      expect(readlinkSync(box.path(".claude", target))).toBe(box.path("repo", source));
    if (existing) expect(readdirSync(box.path(".claude/skills")).toSorted()).toEqual(["ship", "synced"]);
  });

  test("refuses a directory where a local link belongs", () => {
    box.mkdir(".claude", "skills");

    expect(call("install_claude_symlinks local")).toMatchObject({ status: 1, stderr: expect.stringContaining("is a directory") });
  });
});

describe("install_claude_managed", () => {
  test.each([
    { name: "links into a writable directory", env: {}, stdout: "50-dotfiles.json", linked: true },
    { name: "skips a directory that needs sudo off a terminal", env: { CLAUDE_MANAGED_DIR: "/dev/null/managed", NONINTERACTIVE: "1" }, stderr: "needs sudo", linked: false },
  ])("$name", ({ env, stdout = "", stderr = "", linked }) => {
    const result = call("install_claude_managed", env);

    expect(result).toMatchObject({ status: 0, stdout: expect.stringContaining(stdout), stderr: expect.stringContaining(stderr) });
    if (linked) {
      expect(readlinkSync(box.path("managed/50-dotfiles.json"))).toBe(box.path("repo/managed/settings.json"));
      expect(call("install_claude_managed").stdout).toBe("");
    }
  });
});

describe("install_claude_local_marketplace", () => {
  test("declares the clone in a generated file the drop-in links to", () => {
    const env = { XDG_STATE_HOME: box.path("state") };
    const result = call("install_claude_local_marketplace", env);

    expect(result).toMatchObject({ status: 0, stdout: expect.stringContaining("60-local.json") });
    const file = box.path("state/claude/local-settings.json");
    expect(readlinkSync(box.path("managed/60-local.json"))).toBe(file);
    expect(JSON.parse(box.read("state/claude/local-settings.json"))).toEqual({
      extraKnownMarketplaces: { bendrucker: { source: { source: "directory", path: box.path("repo") } } },
    });
    expect(call("install_claude_local_marketplace", env).stdout).toBe("");
  });
});
