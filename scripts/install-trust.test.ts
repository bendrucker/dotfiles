import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "install-trust");

let box: Sandbox;
let trustJson: string;
// The fallback case empties this to exercise the brew --repository path.
let repository: string;

beforeEach(() => {
  box = sandbox("install-trust");
  box.mkdir("repo", "Library", "Taps");
  box.mkdir("config", "homebrew");
  box.write("declared", "");
  trustJson = box.path("config", "homebrew", "trust.json");
  repository = box.path("repo");
  box.write("repository", `${box.path("repo")}\n`);

  box.stub(
    "brew",
    [
      'case "$1" in',
      '  bundle) cat "$FIXTURES/declared" ;;',
      '  --repository) cat "$FIXTURES/repository" ;;',
      // The pins reach Homebrew's own clone through the environment, so the tap
      // stub records what a child git would read rather than only the tap name.
      '  tap) echo "$2" >> "$FIXTURES/tapped"',
      '    i=0',
      '    while [ "$i" -lt "${GIT_CONFIG_COUNT:-0}" ]; do',
      '      eval "key=\\$GIT_CONFIG_KEY_$i value=\\$GIT_CONFIG_VALUE_$i"',
      '      echo "$key=$value" >> "$FIXTURES/gitconfig"',
      '      i=$((i + 1))',
      '    done',
      '    if grep -qx "$2" "$FIXTURES/tap-fails" 2>/dev/null; then exit 128; fi',
      '    ;;',
      '  trust) shift; echo "$*" >> "$FIXTURES/trusted"',
      '    if [ -f "$FIXTURES/trust-fails" ]; then exit 1; fi',
      '    ;;',
      "esac",
    ].join("\n"),
  );
});

afterEach(() => {
  box.remove();
});

function declared(...taps: string[]) {
  box.write("declared", `${taps.join("\n")}\n`);
}

function splitTap(tap: string): [string, string] {
  const slash = tap.indexOf("/");
  return [tap.slice(0, slash), tap.slice(slash + 1)];
}

function installed(...taps: string[]) {
  for (const tap of taps) {
    const [user, repo] = splitTap(tap);
    box.mkdir("repo", "Library", "Taps", user, `homebrew-${repo}`);
  }
}

function shallow(tap: string) {
  const [user, repo] = splitTap(tap);
  box.write(`repo/Library/Taps/${user}/homebrew-${repo}/.git/shallow`, "");
}

function tapFails(...taps: string[]) {
  box.write("tap-fails", `${taps.join("\n")}\n`);
}

function trustFails() {
  box.write("trust-fails", "");
}

function staleTrust() {
  box.write("config/homebrew/trust.json", '{"trustedtaps":["gone/away"]}\n');
}

function tapped(): string {
  return box.read("tapped").trim();
}

function trusted(): string {
  return box.read("trusted").trim();
}

function gitConfig(): string[] {
  return box.read("gitconfig").trim().split("\n").filter(Boolean);
}

// The ambient environment carries git config of its own (the sandbox sets
// safe.directory entries), so the count is pinned here to keep the pins the
// script adds the only ones an assertion sees.
function runScript(env: Record<string, string> = {}) {
  return run([script, box.dir], {
    path: [box.bin],
    env: {
      HOMEBREW_REPOSITORY: repository,
      XDG_CONFIG_HOME: box.path("config"),
      FIXTURES: box.dir,
      GIT_CONFIG_COUNT: "0",
      ...env,
    },
  });
}

describe("install-trust", () => {
  test("does not tap a repository that is already on disk", () => {
    declared("oven-sh/bun", "schpet/tap");
    installed("oven-sh/bun", "schpet/tap");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(tapped()).toBe("");
  });

  test("taps only the repositories missing from disk", () => {
    declared("oven-sh/bun", "schpet/tap");
    installed("oven-sh/bun");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(tapped()).toBe("schpet/tap");
  });

  test("matches the downcased tap directory Homebrew installs into", () => {
    declared("Oven-SH/Bun");
    installed("oven-sh/bun");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(tapped()).toBe("");
  });

  test("trusts every declared tap in a single call", () => {
    declared("oven-sh/bun", "schpet/tap", "pulumi/tap");
    installed("oven-sh/bun", "schpet/tap", "pulumi/tap");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(trusted()).toBe("--tap oven-sh/bun schpet/tap pulumi/tap");
  });

  test("rebuilds the trust file from scratch so a dropped tap drops out", () => {
    staleTrust();
    declared("oven-sh/bun");
    installed("oven-sh/bun");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(existsSync(trustJson)).toBe(false);
    expect(trusted()).toBe("--tap oven-sh/bun");
  });

  // `brew trust` with no targets prints the trusted list instead of writing it.
  test("clears the trust file without calling trust when nothing is declared", () => {
    staleTrust();

    const r = runScript();
    expect(r.status).toBe(0);
    expect(existsSync(trustJson)).toBe(false);
    expect(trusted()).toBe("");
  });

  test("falls back to asking brew for the repository path", () => {
    declared("oven-sh/bun");
    installed("oven-sh/bun");
    repository = "";

    const r = runScript();
    expect(r.status).toBe(0);
    expect(tapped()).toBe("");
  });

  // An insteadOf rule mapping https://github.com/ to git@github.com: sends the
  // clone to SSH, where Secretive cannot sign against a locked Mac. Git applies
  // the longest matching rule, so a rule keyed on the tap's own URL wins.
  test("pins the tap URL to itself so an insteadOf rule cannot reach it", () => {
    declared("schpet/tap");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(gitConfig()).toEqual([
      "url.https://github.com/schpet/homebrew-tap.insteadOf=https://github.com/schpet/homebrew-tap",
    ]);
  });

  test("pins the downcased URL too, since git matches the prefix literally", () => {
    declared("Oven-SH/Bun");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(gitConfig()).toEqual([
      "url.https://github.com/Oven-SH/homebrew-Bun.insteadOf=https://github.com/Oven-SH/homebrew-Bun",
      "url.https://github.com/oven-sh/homebrew-bun.insteadOf=https://github.com/oven-sh/homebrew-bun",
    ]);
  });

  test("appends to the environment's git config rather than replacing it", () => {
    declared("schpet/tap");

    const r = runScript({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/somewhere",
    });
    expect(r.status).toBe(0);
    expect(gitConfig()).toEqual([
      "safe.directory=/somewhere",
      "url.https://github.com/schpet/homebrew-tap.insteadOf=https://github.com/schpet/homebrew-tap",
    ]);
  });

  test("leaves a tap already on disk unpinned, since nothing clones it", () => {
    declared("schpet/tap");
    installed("schpet/tap");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(existsSync(box.path("gitconfig"))).toBe(false);
  });

  // `brew tap` is only a no-op on a tap that is installed and not shallow. On a
  // shallow one it is what runs `git fetch --unshallow`.
  test("taps a repository whose clone on disk is shallow", () => {
    declared("oven-sh/bun");
    installed("oven-sh/bun");
    shallow("oven-sh/bun");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(tapped()).toBe("oven-sh/bun");
  });

  // scripts/install runs under `set -e` well before brew bundle, mise and the
  // symlinks, so a tap that exits nonzero used to take the whole install with
  // it and leave the machine without every formula a Brewfile declares.
  describe("a tap that cannot be cloned", () => {
    test("does not stop the taps after it", () => {
      declared("greptileai/tap", "schpet/tap");
      tapFails("greptileai/tap");

      const r = runScript();
      expect(r.status).toBe(0);
      expect(tapped()).toBe("greptileai/tap\nschpet/tap");
    });

    test("is named on stderr", () => {
      declared("greptileai/tap", "schpet/tap");
      tapFails("greptileai/tap");

      const r = runScript();
      expect(r.stderr).toContain("greptileai/tap");
      expect(r.stderr).not.toContain("schpet/tap");
    });

    test("is left out of the trust list", () => {
      declared("greptileai/tap", "schpet/tap");
      tapFails("greptileai/tap");

      const r = runScript();
      expect(r.status).toBe(0);
      expect(trusted()).toBe("--tap schpet/tap");
    });

    test("trusts nothing when it was the only tap declared", () => {
      declared("greptileai/tap");
      tapFails("greptileai/tap");

      const r = runScript();
      expect(r.status).toBe(0);
      expect(trusted()).toBe("");
    });
  });

  // A tap on disk still installs from it. What trust gates is brew bundle
  // reading a formula out of one, which is next run's problem rather than a
  // reason to abandon the install steps after this.
  test("carries on when brew trust itself fails", () => {
    declared("oven-sh/bun");
    installed("oven-sh/bun");
    trustFails();

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("brew trust failed");
  });
});
