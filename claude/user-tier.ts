#!/usr/bin/env bun
//
// An employer's MDM profile or server-managed settings outrank the drop-ins
// install.sh links, and Claude Code skips a lower managed source instead of
// merging it. On such a machine the managed settings move down a tier, into a
// generated ~/.claude/settings.json that merges them over user/settings.json.
//
// install.sh runs it as a script once its own checks find such a source.

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const PROFILE = "com.anthropic.claudecode.plist";

export function managedOutranked(env: Record<string, string | undefined> = process.env): boolean {
  const prefs = env.CLAUDE_MANAGED_PREFS_DIR ?? "/Library/Managed Preferences";
  return [
    join(prefs, PROFILE),
    join(prefs, userInfo().username, PROFILE),
    join(env.HOME || homedir(), ".claude", "remote-settings.json"),
  ].some((path) => existsSync(path));
}

// Objects merge by key, lists union, and anything else takes the later value,
// the way Claude Code combines a key set at two levels.
export function mergeSettings(base: Json, over: Json): Json {
  if (Array.isArray(base) && Array.isArray(over)) {
    const seen = new Set(base.map((item) => JSON.stringify(item)));
    return [...base, ...over.filter((item) => !seen.has(JSON.stringify(item)))];
  }
  if (isObject(base) && isObject(over)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(over)) merged[key] = key in base ? mergeSettings(base[key], value) : value;
    return merged;
  }
  return over;
}

// Replaced by rename, so the link it supersedes is never written through into
// the repo. An unchanged file is left alone, since Claude Code reloads on a write.
export function writeUserTierSettings(repoDir: string, home: string): void {
  const marketplace = { extraKnownMarketplaces: { bendrucker: { source: { source: "directory", path: repoDir } } } };
  const merged = [readJson(join(repoDir, "managed/settings.json")), marketplace].reduce(
    mergeSettings,
    readJson(join(repoDir, "user/settings.json")),
  );
  const text = `${JSON.stringify(merged, null, 2)}\n`;

  const target = join(home, ".claude", "settings.json");
  if (isRegularFile(target) && readFileSync(target, "utf8") === text) return;
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, target);
}

function readJson(path: string): Json {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const home = process.env.HOME || homedir();
  writeUserTierSettings(process.env.CLAUDE_REPO_HOME || join(home, ".claude-repo"), home);
}
