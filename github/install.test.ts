import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "#harness";

// install.sh reads extensions.conf out of its own directory and reaches its
// siblings by relative path, so the sandbox mirrors the layout it expects: a
// copy of the script beside a fixture conf, with the shell library it sources
// linked back to the real one and bin/git-sync stubbed.

let box: Sandbox;
let script: string;

beforeEach(() => {
  box = sandbox("github-install");
  stubGum(box);

  box.mkdir("scripts");
  symlinkSync(join(repoRoot, "scripts", "shell"), box.path("scripts", "shell"));

  // The script reaches it as ../bin/git-sync, which is the stub directory.
  // $HEAL_FAILS names the one checkout this stub refuses to heal.
  box.stub(
    "git-sync",
    [
      '[ "$2" = "${HEAL_FAILS:-}" ] && { echo "X could not reach $2" >&2; exit 1; }',
      'echo "git-sync $*" >> "$FIXTURES/calls"',
    ].join("\n"),
  );

  // The checkouts are fixtures rather than repositories, so the pin git applies
  // after the install is recorded rather than performed.
  box.stub("git", 'echo "git $*" >> "$FIXTURES/calls"');

  script = box.write(
    "github/install.sh",
    readFileSync(join(repoRoot, "github", "install.sh"), "utf8"),
  );
  chmodSync(script, 0o755);
});

afterEach(() => {
  box.remove();
});

function declared(...lines: string[]) {
  box.write("github/extensions.conf", `${lines.join("\n")}\n`);
}

/** An extension already on disk, which is the shape that has a remote to heal. */
function checkedOut(name: string): string {
  box.mkdir("data", "gh", "extensions", name, ".git");
  return box.path("data", "gh", "extensions", name);
}

// The real gh reports an unreachable extension with a nonzero exit. $FAILING
// names the one repo this stub refuses, so a test can pick which one breaks.
function stubGh() {
  box.stub(
    "gh",
    [
      'case "$1 $2" in',
      '  "extension list") exit 0 ;;',
      "esac",
      'for arg in "$@"; do',
      '  [ "$arg" = "${FAILING:-}" ] || continue',
      '  echo "X Failed upgrading extension $arg" >&2',
      "  exit 1",
      "done",
      'echo "gh $*" >> "$FIXTURES/calls"',
      'echo "$*" >> "$FIXTURES/installed"',
    ].join("\n"),
  );
}

// XDG_DATA_HOME is pinned into the sandbox so the extension directory the
// script probes is the fixture rather than whatever this machine has installed.
function runScript(env: Record<string, string | undefined> = {}): Run {
  return run([script], {
    path: [box.bin],
    env: {
      FIXTURES: box.dir,
      XDG_DATA_HOME: box.path("data"),
      NONINTERACTIVE: "1",
      ...env,
    },
  });
}

function attempted(): string[] {
  return box
    .read("installed")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ").at(-1) as string)
    .sort();
}

/** Every stubbed command the run reached, in the order it reached them. */
function calls(): string[] {
  return box.read("calls").trim().split("\n").filter(Boolean);
}

describe("github/install.sh", () => {
  beforeEach(stubGh);

  test("installs every declared extension at its pinned tag", () => {
    declared("dlvhdr/gh-dash v4.25.2", "chmouel/gh-news v0.18.0");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(attempted()).toEqual(["chmouel/gh-news", "dlvhdr/gh-dash"]);
  });

  // An install whose brew, mise, and symlink steps already succeeded should not
  // fail over one extension, and the extensions after it in the loop still
  // deserve an attempt.
  test("keeps going and still succeeds when one extension fails", () => {
    declared("dlvhdr/gh-dash v4.25.2", "einride/gh-dependabot v0.14.1", "chmouel/gh-news v0.18.0");

    const r = runScript({ FAILING: "einride/gh-dependabot" });
    expect(r.status).toBe(0);
    expect(attempted()).toEqual(["chmouel/gh-news", "dlvhdr/gh-dash"]);
  });

  test("names the failed extension on stderr", () => {
    declared("dlvhdr/gh-dash v4.25.2", "einride/gh-dependabot v0.14.1");

    const r = runScript({ FAILING: "einride/gh-dependabot" });
    expect(r.stderr).toContain("einride/gh-dependabot @ v0.14.1");
  });

  test("says nothing about failures when every extension installs", () => {
    declared("dlvhdr/gh-dash v4.25.2");

    const r = runScript();
    expect(r.stderr).not.toContain("could not be installed");
  });

  test("rejects an extension declared without a version", () => {
    declared("dlvhdr/gh-dash");

    const r = runScript();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing version");
  });

  // gh resolves a script extension's latest version against the clone's own
  // stored remote, so the transport has to be corrected before gh runs, not
  // after. Ordering is the whole point of the step and is what this asserts.
  test("heals an existing checkout's remote before gh reads it", () => {
    declared("dlvhdr/gh-dash v4.25.2");
    const dir = checkedOut("gh-dash");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(calls()).toEqual([
      `git-sync https-remote ${dir}`,
      "gh extension install --force --pin v4.25.2 dlvhdr/gh-dash",
      `git -C ${dir} fetch --tags --quiet origin`,
      `git -C ${dir} -c advice.detachedHead=false checkout --quiet refs/tags/v4.25.2`,
    ]);
  });

  // A binary extension, or one gh has never installed, has no clone to correct.
  test("leaves an extension that is not on disk to gh alone", () => {
    declared("dlvhdr/gh-dash v4.25.2");

    const r = runScript();
    expect(r.status).toBe(0);
    expect(calls()).toEqual(["gh extension install --force --pin v4.25.2 dlvhdr/gh-dash"]);
  });

  // Installing over a remote that could not be corrected is the failure this
  // change exists to avoid, so a failed heal has to stop that extension rather
  // than fall through to gh.
  test("stops an extension whose remote could not be healed", () => {
    declared("dlvhdr/gh-dash v4.25.2", "chmouel/gh-news v0.18.0");
    const dir = checkedOut("gh-dash");

    const r = runScript({ HEAL_FAILS: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("dlvhdr/gh-dash @ v4.25.2");
    expect(attempted()).toEqual(["chmouel/gh-news"]);
  });
});
