import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "./lib/shell-fixtures.ts";

const script = join(repoRoot, "scripts", "install-trust");

let box: Sandbox;
let trustJson: string;
// The fallback spec empties this to exercise the brew --repository path.
let repository: string;

beforeEach(() => {
  box = sandbox("install-trust");
  box.mkdir("repo", "Library", "Taps");
  box.mkdir("config", "homebrew");
  box.write("declared", "");
  trustJson = box.path("config", "homebrew", "trust.json");
  repository = box.path("repo");
  box.write("repository", `${box.path("repo")}\n`);

  // Each invocation appends one line, so the specs can count calls as well as
  // check arguments.
  box.stub(
    "brew",
    [
      'case "$1" in',
      '  bundle) cat "$FIXTURES/declared" ;;',
      '  --repository) cat "$FIXTURES/repository" ;;',
      '  tap) echo "$2" >> "$FIXTURES/tapped" ;;',
      '  trust) shift; echo "$*" >> "$FIXTURES/trusted" ;;',
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

function staleTrust() {
  box.write("config/homebrew/trust.json", '{"trustedtaps":["gone/away"]}\n');
}

function tapped(): string {
  return box.read("tapped").trim();
}

function trusted(): string {
  return box.read("trusted").trim();
}

function runScript() {
  return run([script, box.dir], {
    path: [box.bin],
    env: { HOMEBREW_REPOSITORY: repository, XDG_CONFIG_HOME: box.path("config"), FIXTURES: box.dir },
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
});
