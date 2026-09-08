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
  box.stub("git-sync", "exit 0");

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
      'echo "$*" >> "$FIXTURES/installed"',
    ].join("\n"),
  );
}

function runScript(failing?: string): Run {
  return run([script], {
    path: [box.bin],
    env: { FIXTURES: box.dir, FAILING: failing, NONINTERACTIVE: "1" },
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

    const r = runScript("einride/gh-dependabot");
    expect(r.status).toBe(0);
    expect(attempted()).toEqual(["chmouel/gh-news", "dlvhdr/gh-dash"]);
  });

  test("names the failed extension on stderr", () => {
    declared("dlvhdr/gh-dash v4.25.2", "einride/gh-dependabot v0.14.1");

    const r = runScript("einride/gh-dependabot");
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
});
