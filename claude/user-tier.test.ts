import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, symlinkSync } from "node:fs";
import { sandbox, type Sandbox } from "#harness";
import { managedOutranked, mergeSettings, writeUserTierSettings } from "./user-tier";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("user-tier");
});

afterEach(() => {
  box.remove();
});

describe("managedOutranked", () => {
  test.each([
    { name: "an MDM profile", file: "prefs/com.anthropic.claudecode.plist", outranked: true },
    { name: "a server-managed cache", file: ".claude/remote-settings.json", outranked: true },
    { name: "only the drop-ins", file: "managed/50-dotfiles.json", outranked: false },
  ])("$name", ({ file, outranked }) => {
    box.write(file, "");

    expect(managedOutranked({ HOME: box.dir, CLAUDE_MANAGED_PREFS_DIR: box.path("prefs") })).toBe(outranked);
  });
});

describe("mergeSettings", () => {
  test("merges objects by key, unions lists, and takes the later scalar", () => {
    const user = { model: "opus", permissions: { allow: ["Bash(ls:*)", "Bash(jq:*)"] }, theme: "dark" };
    const managed = { model: "sonnet", permissions: { allow: ["Bash(jq:*)", "Bash(bun:*)"], deny: ["Read(.env)"] } };

    expect(mergeSettings(user, managed)).toEqual({
      model: "sonnet",
      permissions: { allow: ["Bash(ls:*)", "Bash(jq:*)", "Bash(bun:*)"], deny: ["Read(.env)"] },
      theme: "dark",
    });
  });
});

describe("writeUserTierSettings", () => {
  beforeEach(() => {
    box.write("repo/user/settings.json", JSON.stringify({ theme: "dark" }));
    box.write("repo/managed/settings.json", JSON.stringify({ cleanupPeriodDays: 90 }));
    box.mkdir(".claude");
  });

  test("replaces the link with a merged file and leaves the repo's copy alone", () => {
    symlinkSync(box.path("repo/user/settings.json"), box.path(".claude/settings.json"));

    writeUserTierSettings(box.path("repo"), box.dir);

    expect(lstatSync(box.path(".claude/settings.json")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(box.path(".claude/settings.json"), "utf8"))).toEqual({
      theme: "dark",
      cleanupPeriodDays: 90,
      extraKnownMarketplaces: { bendrucker: { source: { source: "directory", path: box.path("repo") } } },
    });
    expect(readFileSync(box.path("repo/user/settings.json"), "utf8")).toBe(JSON.stringify({ theme: "dark" }));
  });

  test("leaves an up-to-date file unwritten", () => {
    writeUserTierSettings(box.path("repo"), box.dir);
    const written = lstatSync(box.path(".claude/settings.json")).ino;

    writeUserTierSettings(box.path("repo"), box.dir);

    expect(lstatSync(box.path(".claude/settings.json")).ino).toBe(written);
  });
});
