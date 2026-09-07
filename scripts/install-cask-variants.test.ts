import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "install-cask-variants");

const brewBody = [
  'case "$1 $2" in',
  '  "bundle list") cat "$FIXTURES/declared"; [ -f "$FIXTURES/list-nonzero" ] && exit 1; exit 0 ;;',
  '  "list --cask") cat "$FIXTURES/installed" ;;',
  '  "info --json=v2") cat "$FIXTURES/info-$4.json" 2>/dev/null || cat "$FIXTURES/info.json" ;;',
  '  "uninstall --cask") grep -qxF "$3" "$FIXTURES/uninstall-fails" 2>/dev/null && exit 1;',
  '    echo "$3" >> "$FIXTURES/uninstalled" ;;',
  "esac",
].join("\n");

let box: Sandbox;
let nojq: string;

beforeEach(() => {
  box = sandbox("install-cask-variants");
  box.write("declared", "");
  box.write("installed", "");
  box.write("info.json", '{"casks":[{"conflicts_with":{"cask":[]}}]}\n');
  box.write("uninstalled", "");

  // The script only runs on macOS, and the suite runs on Linux too.
  box.stub("uname", "echo Darwin");
  box.stub("brew", brewBody);

  // macOS ships /usr/bin/jq, so testing the missing-jq path needs a PATH
  // holding only what the script legitimately calls.
  nojq = box.mkdir("nojq");
  box.stub("nojq/uname", "echo Darwin");
  box.stub("nojq/brew", brewBody);
  for (const tool of ["sh", "dirname", "cut", "sed", "grep", "cat"]) {
    const real = Bun.which(tool);
    if (real === null) throw new Error(`${tool} is not on PATH`);
    symlinkSync(real, join(nojq, tool));
  }
});

afterEach(() => {
  box.remove();
});

function declared(...casks: string[]) {
  box.write("declared", casks.length ? `${casks.join("\n")}\n` : "");
}

function installed(...casks: string[]) {
  box.write("installed", casks.length ? `${casks.join("\n")}\n` : "");
}

function conflicts(cask: string) {
  box.write("info.json", `{"casks":[{"conflicts_with":{"cask":["${cask}"]}}]}\n`);
}

function uninstalled(): string {
  return box.read("uninstalled").trim();
}

// jq is real; only brew and uname are stubbed.
function runScript() {
  return run([script, box.dir], { path: [box.bin], env: { FIXTURES: box.dir } });
}

// jq comes from the brew bundle that runs after this script.
function runWithoutJq() {
  return run([script, box.dir], { onlyPath: [nojq], env: { FIXTURES: box.dir } });
}

describe("install-cask-variants", () => {
  test("uninstalls the cask a declared variant supersedes", () => {
    declared("ghostty@tip");
    installed("ghostty");
    conflicts("ghostty");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("uninstalling ghostty, superseded by ghostty@tip");
    expect(uninstalled()).toBe("ghostty");
  });

  test("does nothing when the installed cask is still declared", () => {
    declared("ghostty@tip");
    installed("ghostty@tip");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(uninstalled()).toBe("");
  });

  // Homebrew's own conflict data decides, so the @suffix naming only nominates.
  test("keeps a same-base cask that Homebrew does not report as conflicting", () => {
    declared("ghostty@tip");
    installed("ghostty");
    conflicts("something-else");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(uninstalled()).toBe("");
  });

  // Homebrew's own cask cannot name a personal tap's variant, so retiring that
  // variant works only if the variant's own metadata is consulted.
  test("uninstalls a variant when only the variant declares the conflict", () => {
    declared("font-monaspice-nerd-font");
    installed("font-monaspice-nerd-font@tip");
    box.write("info-font-monaspice-nerd-font.json", '{"casks":[{"conflicts_with":{"cask":[]}}]}\n');
    box.write(
      "info-font-monaspice-nerd-font@tip.json",
      '{"casks":[{"conflicts_with":{"cask":["font-monaspice-nerd-font"]}}]}\n',
    );

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("uninstalling font-monaspice-nerd-font@tip, superseded by font-monaspice-nerd-font");
    expect(uninstalled()).toBe("font-monaspice-nerd-font@tip");
  });

  // The declared cask answered, so the pair is unconfirmed rather than unknown.
  test("skips without failing when only the installed cask's metadata is unreadable", () => {
    declared("ghostty@tip");
    installed("ghostty");
    box.write("info-ghostty@tip.json", '{"casks":[{"conflicts_with":{"cask":[]}}]}\n');
    box.write("info-ghostty.json", "not json at all\n");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(uninstalled()).toBe("");
  });

  // Aborting mid-run would leave an app uninstalled with its replacement not yet
  // installed, so confirmation for every candidate has to finish first.
  test("uninstalls nothing when a later candidate cannot be confirmed", () => {
    declared("ghostty@tip", "claude-code@latest");
    installed("ghostty", "claude-code");
    box.write("info-ghostty@tip.json", '{"casks":[{"conflicts_with":{"cask":["ghostty"]}}]}\n');
    box.write("info-claude-code@latest.json", "not json at all\n");

    const r = runScript();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot read Homebrew metadata");
    expect(uninstalled()).toBe("");
  });

  // Unreadable metadata is a different answer from "they don't conflict".
  test("fails rather than skipping when the cask metadata cannot be read", () => {
    declared("ghostty@tip");
    installed("ghostty");
    box.write("info.json", "not json at all\n");

    const r = runScript();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot read Homebrew metadata for ghostty@tip");
    expect(r.stderr).toContain("brew uninstall --cask ghostty");
    expect(uninstalled()).toBe("");
  });

  test("leaves a conflicting cask alone when it is not a variant of a declared one", () => {
    declared("docker-desktop");
    installed("rancher");
    conflicts("rancher");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(uninstalled()).toBe("");
  });

  // An empty list from a failed lookup is indistinguishable from "nothing is
  // superseded", and the latter exits 0.
  test("fails when the cask lists cannot be enumerated", () => {
    installed("ghostty");
    box.write("declared", "");
    box.write("list-nonzero", "");

    const r = runScript();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot enumerate casks");
    expect(uninstalled()).toBe("");
  });

  // brew exits nonzero while still printing a complete list when something
  // incidental fails, such as a cache refresh it could not write. A usable list
  // has to win over the status, or bootstrap breaks on a warning.
  test("proceeds when the lookup prints a full list but exits nonzero", () => {
    declared("ghostty@tip");
    installed("ghostty");
    conflicts("ghostty");
    box.write("list-nonzero", "");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(uninstalled()).toBe("ghostty");
  });

  // Once removal has started, aborting strands an app that brew bundle has not
  // replaced yet, so the run continues and lets bundle report the rest.
  test("keeps going when one uninstall fails", () => {
    declared("ghostty@tip", "claude-code@latest");
    installed("ghostty", "claude-code");
    box.write("info-ghostty@tip.json", '{"casks":[{"conflicts_with":{"cask":["ghostty"]}}]}\n');
    box.write("info-claude-code@latest.json", '{"casks":[{"conflicts_with":{"cask":["claude-code"]}}]}\n');
    box.write("uninstall-fails", "ghostty\n");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not uninstall ghostty");
    expect(uninstalled()).toBe("claude-code");
  });

  test("exits quietly when nothing is installed", () => {
    declared("ghostty@tip");
    installed();

    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // Skipping quietly here would let brew bundle fail later on the conflict,
  // which is the failure this script exists to prevent.
  test("fails with the manual command when jq is unavailable to confirm", () => {
    declared("ghostty@tip");
    installed("ghostty");

    const r = runWithoutJq();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("jq is not available");
    expect(r.stderr).toContain("brew uninstall --cask ghostty");
    expect(uninstalled()).toBe("");
  });

  test("does not need jq when there is nothing to retire", () => {
    declared("ghostty@tip");
    installed("ghostty@tip");

    const r = runWithoutJq();
    expect(r.status).toBe(0);
  });
});
