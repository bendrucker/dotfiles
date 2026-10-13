import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { must, repoRoot, sandbox, type Sandbox } from "#harness";

let box: Sandbox;
let confd: string;

// A home of its own, entered as the working directory: mise also reads the
// config directories of every ancestor of the one it runs in.
beforeEach(() => {
  box = sandbox("mise-confd");
  confd = join(box.mkdir("home", ".config", "mise"), "conf.d");
  symlinkSync(repoRoot, confd);
});

afterEach(() => {
  box.remove();
});

function mise(...args: string[]): string {
  const home = box.path("home");
  return must(["mise", ...args], {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      MISE_GLOBAL_CONFIG_FILE: undefined,
      MISE_ENV: undefined,
    },
  });
}

describe("mise conf.d linked to the dotfiles root", () => {
  test("loads every topic's mise.toml", () => {
    const topics = readdirSync(repoRoot).filter((topic) => existsSync(join(repoRoot, topic, "mise.toml")));
    const loaded = mise("config", "ls", "--no-header")
      .split("\n")
      .map((line) => line.split(/\s+/)[0]?.split("/conf.d/")[1]);

    expect(loaded).toEqual(expect.arrayContaining(topics.map((topic) => `${topic}/mise.toml`)));
  });

  test("loads a topic's mise.<env>.toml only while <env> is selected", () => {
    box.write("other/probe/mise.probe.toml", '[env]\nDOTFILES_MODULE_PROBE = "on"\n');
    unlinkSync(confd);
    symlinkSync(box.path("other"), confd);

    expect(mise("env")).not.toContain("DOTFILES_MODULE_PROBE");
    expect(mise("--env", "probe", "env")).toContain("export DOTFILES_MODULE_PROBE=on");
  });

  test("follows the link to another root with no reapply", () => {
    box.write("other/probe/mise.toml", '[env]\nDOTFILES_ROOT_PROBE = "other"\n');
    expect(mise("env")).not.toContain("DOTFILES_ROOT_PROBE");

    unlinkSync(confd);
    symlinkSync(box.path("other"), confd);

    expect(mise("env")).toContain("export DOTFILES_ROOT_PROBE=other");
  });
});
