import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, shell, type Sandbox } from "#harness";

const install = join(repoRoot, "claude", "install.sh");
const link = join(repoRoot, "claude", "link");

let box: Sandbox;
let repo: string;
let managed: string;

beforeEach(() => {
  box = sandbox("claude-install");
  repo = box.path("repo");
  box.write("repo/user/settings.json", "{}\n");
  box.write("repo/user/CLAUDE.md", "# Claude\n");
  box.write("repo/user/skills/ship/SKILL.md", "");
  box.write("repo/managed/settings.json", "{}\n");
  box.write("repo/platforms/mac/CLAUDE.md", "# Mac\n");
  box.write("repo/platforms/cloud/CLAUDE.md", "# Cloud\n");
  box.write("repo/platforms/cloud/settings.json", "{}\n");
  box.mkdir(".claude");
  managed = box.path("managed-settings.d");
});

afterEach(() => {
  box.remove();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: box.dir, CLAUDE_REPO_HOME: repo, CLAUDE_MANAGED_DIR: managed, ...extra };
}

function target(...parts: string[]): string {
  return readlinkSync(box.path(".claude", ...parts));
}

describe("claude/link cloud", () => {
  test("links the cloud's own settings and platform guidance beside the user files", () => {
    expect(run([link, "cloud"], { env: env() }).status).toBe(0);

    expect(target("settings.json")).toBe(join(repo, "platforms/cloud/settings.json"));
    expect(target("CLAUDE.md")).toBe(join(repo, "user/CLAUDE.md"));
    expect(target("platform.md")).toBe(join(repo, "platforms/cloud/CLAUDE.md"));
    expect(readlinkSync(join(managed, "50-bendrucker.json"))).toBe(join(repo, "managed/settings.json"));
  });

  test("links skills inside a directory claude.ai sync already owns, and prunes the ones that left", () => {
    box.mkdir(".claude", "skills", "synced");
    symlinkSync(join(repo, "user/skills/gone"), box.path(".claude", "skills", "gone"));

    expect(run([link, "cloud"], { env: env() }).status).toBe(0);

    expect(readdirSync(box.path(".claude", "skills")).toSorted()).toEqual(["ship", "synced"]);
    expect(target("skills", "ship")).toBe(join(repo, "user/skills/ship"));
  });
});

describe("install_claude_symlinks mac", () => {
  test("refuses a directory where a link belongs", () => {
    box.mkdir(".claude", "skills");

    const result = shell(`. "$1" && install_claude_symlinks mac`, { args: [install], env: env() });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is a directory");
  });

  test("links user/settings.json and the Mac guidance", () => {
    expect(shell(`. "$1" && install_claude_symlinks mac`, { args: [install], env: env() }).status).toBe(0);

    expect(target("settings.json")).toBe(join(repo, "user/settings.json"));
    expect(target("platform.md")).toBe(join(repo, "platforms/mac/CLAUDE.md"));
  });
});

describe("install_claude_managed", () => {
  function managedRun(extra: Record<string, string> = {}) {
    return shell(`. "$1" && install_claude_managed`, { args: [install], env: env(extra) });
  }

  test("skips with a note when the directory needs sudo and no one is at a terminal", () => {
    box.write("managed-settings.d", "");

    const result = managedRun({ NONINTERACTIVE: "1", CLAUDE_MANAGED_DIR: join(managed, "nested") });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("needs sudo");
  });

  test("links ahead of the config repo shipping managed settings, and leaves a correct link alone", () => {
    box.remove();
    box = sandbox("claude-install");
    repo = box.mkdir("repo");
    managed = box.path("managed-settings.d");

    expect(managedRun().stdout).toContain("50-bendrucker.json");
    expect(readlinkSync(join(managed, "50-bendrucker.json"))).toBe(join(repo, "managed/settings.json"));
    expect(managedRun()).toMatchObject({ status: 0, stdout: "" });
  });
});
