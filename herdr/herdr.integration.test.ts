import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run } from "#harness";

const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config");
const config = join(xdgConfigHome, "herdr", "config.toml");
const list = join(repoRoot, "herdr", "plugins.list");
const pluginConfig = join(xdgConfigHome, "herdr", "plugins", "config");

describe("herdr", () => {
  test("symlinks the config into place", () => {
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
  });

  test("config is readable and non-empty", () => {
    expect(statSync(config).size).toBeGreaterThan(0);
  });

  // A directory link, so a new plugin's config goes live as soon as it exists in the repo.
  test("symlinks the whole plugin config tree", () => {
    expect(lstatSync(pluginConfig).isSymbolicLink()).toBe(true);
  });

  test("reaches a plugin's config through that link", () => {
    const path = join(pluginConfig, "persiyanov.reviewr", "config.toml");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  test("declares the plugin set in plugins.list", () => {
    expect(statSync(list).size).toBeGreaterThan(0);
  });

  // .zshrc sources every $ZSH/**/*.zsh bar path.zsh and completion.zsh, so
  // sourcing herdr.zsh under a chosen $ZSH is what a login shell does to it.
  // `zsh -f` keeps ~/.zshenv, and the installed root it exports, out of the
  // way. realpath compare rather than a string compare, so this also proves
  // the export names a file that exists.
  test("points HERDR_LAZY_LIST at plugins.list", () => {
    const r = run(["zsh", "-fc", `ZSH=$1; source "$ZSH/herdr/herdr.zsh"; print -r -- $HERDR_LAZY_LIST`, "_", repoRoot]);
    expect(r.status).toBe(0);
    const resolved = r.stdout.trim();
    expect(realpathSync(resolved)).toBe(realpathSync(list));
  });

  // herdr validates its own tokens, so this catches a sidebar row naming a
  // token that does not exist before a reload silently falls back to defaults.
  // A server given a config it cannot parse starts anyway on stock settings,
  // which renders as a change that did nothing rather than as an error.
  test("the tracked config is one herdr accepts", () => {
    const r = run(["herdr", "config", "check"], {
      env: { HERDR_CONFIG_PATH: join(repoRoot, "herdr", "config.toml") },
    });
    expect(r.stdout + r.stderr).toContain("config: ok");
    expect(r.status).toBe(0);
  });
});
