import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { must, repoRoot, sandbox, type Sandbox } from "#harness";

let box: Sandbox;

// A fixture home with no conf.d, as on a fresh machine, and a brew that only
// records what it was asked and what it could see.
beforeEach(() => {
  box = sandbox("homebrew-hook");
  box.stub("brew", 'echo "$PWD|$*|${HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS-unset}" >> "$BREW_LOG"');
});

afterEach(() => {
  box.remove();
});

function packages(env: Record<string, string>): string[] {
  const home = box.mkdir("home");
  must(["sh", "-c", "mise trust --yes --quiet mise.toml && mise bootstrap --only packages --yes </dev/null"], {
    cwd: join(repoRoot, "homebrew"),
    path: [box.bin],
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      MISE_GLOBAL_CONFIG_FILE: undefined,
      MISE_ENV: undefined,
      MISE_OFFLINE: "1",
      DOTFILES_JOB: undefined,
      BREW_LOG: box.path("brew.log"),
      ...env,
    },
  });
  return box.read("brew.log").trim().split("\n");
}

describe("pre-packages hook", () => {
  test("runs brew bundle from the dotfiles root once", () => {
    const bundles = packages({}).filter((line) => line.split("|")[1] === "bundle");
    expect(bundles.map((line) => line.split("|")[0])).toEqual([repoRoot]);
  });

  test("brew bundle sees the self-updating casks left alone from the nightly job", () => {
    const bundle = packages({ DOTFILES_JOB: "dotfiles-upgrade" }).find((line) => line.split("|")[1] === "bundle");
    expect(bundle?.split("|")[2]).toBe("1");
  });
});
