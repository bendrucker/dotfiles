import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  brewfileEntry,
  cleanupListing,
  type Entry,
  NO_OUTPUT_DIAGNOSTIC,
  type Outcome,
  parseCleanupListing,
  report,
  run,
} from "./brew-drift";

const CACHE_LISTING = [
  "Would `brew cleanup`:",
  "Would remove: /opt/homebrew/Cellar/aws-c-auth/0.10.4 (19 files, 418.1KB)",
];

function listing(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("parseCleanupListing", () => {
  test.each<{ name: string; output: string; expected: Entry[] }>([
    {
      name: "labels the formulae under the formula header",
      output: listing("Would uninstall formulae:", "cmake", "ninja"),
      expected: [
        { kind: "formula", token: "cmake" },
        { kind: "formula", token: "ninja" },
      ],
    },
    {
      name: "switches label when the cask header follows the formula list",
      output: listing(
        "Would uninstall formulae:",
        "tree",
        "",
        "Would uninstall casks:",
        "visual-studio-code@insiders",
      ),
      expected: [
        { kind: "formula", token: "tree" },
        { kind: "cask", token: "visual-studio-code@insiders" },
      ],
    },
    {
      name: "labels the taps under the untap header",
      output: listing("Would untap:", "hashicorp/tap", "minamijoyo/tfschema"),
      expected: [
        { kind: "tap", token: "hashicorp/tap" },
        { kind: "tap", token: "minamijoyo/tfschema" },
      ],
    },
    {
      name: "keeps the name and id of a Mac App Store app together",
      output: listing(
        "Would uninstall Mac App Store apps:",
        "Xcode (497799835)",
        "1Password for Safari (1569813296)",
      ),
      expected: [
        { kind: "mas", name: "Xcode", id: "497799835" },
        { kind: "mas", name: "1Password for Safari", id: "1569813296" },
      ],
    },
    {
      name: "keeps the punctuation Homebrew allows in a token",
      output: listing(
        "Would uninstall casks:",
        "logi-options+",
        "font-monaspice-nerd-font",
        "Would uninstall formulae:",
        "postgresql@17",
        "agavra/tap/tuicr",
      ),
      expected: [
        { kind: "cask", token: "logi-options+" },
        { kind: "cask", token: "font-monaspice-nerd-font" },
        { kind: "formula", token: "postgresql@17" },
        { kind: "formula", token: "agavra/tap/tuicr" },
      ],
    },
    // A bare package name reappears inside the download-cache listing, so a
    // section has to close on an unrecognised line rather than skip it.
    {
      name: "stops before the download cache listing",
      output: listing("Would uninstall formulae:", "cmake", "", ...CACHE_LISTING, "ninja"),
      expected: [{ kind: "formula", token: "cmake" }],
    },
    // The app section is the one whose entries carry spaces, so its shape is
    // the one that could otherwise swallow the prose that follows it.
    {
      name: "closes the app section on a line that is not an app",
      output: listing(
        "Would uninstall Mac App Store apps:",
        "Xcode (497799835)",
        "",
        ...CACHE_LISTING,
      ),
      expected: [{ kind: "mas", name: "Xcode", id: "497799835" }],
    },
    // The closing rule costs a valid token that follows an unmatched line in
    // the same section. Homebrew does not indent its entries, so nothing loses
    // a package to this, and a skip rule would collect the cache listing above.
    {
      name: "drops a token that follows an unmatched line in the same section",
      output: listing("Would uninstall formulae:", "cmake", "  indented", "ninja"),
      expected: [{ kind: "formula", token: "cmake" }],
    },
    // These appear only on a Brewfile that declares them, which is what a
    // `vscode` line added later would do.
    {
      name: "ignores managers this repo does not declare",
      output: listing(
        "Would uninstall VS Code extensions:",
        "ms-python.python",
        "Would uninstall npm packages:",
        "typescript",
      ),
      expected: [],
    },
    {
      name: "reports nothing for output with no uninstall sections",
      output: listing(...CACHE_LISTING),
      expected: [],
    },
    {
      name: "reports nothing for empty output",
      output: "",
      expected: [],
    },
    // The header is matched at the start of the line only, so a future Homebrew
    // that appends a count still opens the section.
    {
      name: "opens a section on a header carrying a trailing count",
      output: listing("Would uninstall formulae: 1 formula", "cmake"),
      expected: [{ kind: "formula", token: "cmake" }],
    },
  ])("$name", ({ output, expected }) => {
    expect(parseCleanupListing(output)).toEqual(expected);
  });
});

describe("report", () => {
  test.each<{ name: string; entries: Entry[]; expected: string }>([
    {
      name: "renders each kind as the Brewfile entry that would declare it",
      entries: [
        { kind: "formula", token: "cmake" },
        { kind: "cask", token: "logi-options+" },
        { kind: "tap", token: "hashicorp/tap" },
      ],
      expected: "brew 'cmake'\ncask 'logi-options+'\ntap 'hashicorp/tap'\n",
    },
    {
      name: "splits a Mac App Store app back into a name and an id",
      entries: [
        { kind: "mas", name: "Xcode", id: "497799835" },
        { kind: "mas", name: "1Password for Safari", id: "1569813296" },
      ],
      expected: "mas 'Xcode', id: 497799835\nmas '1Password for Safari', id: 1569813296\n",
    },
    {
      name: "produces nothing for an empty report",
      entries: [],
      expected: "",
    },
  ])("$name", ({ entries, expected }) => {
    expect(report(entries)).toBe(expected);
  });

  // The shell formatter quoted with bare single quotes, so an App Store app
  // whose name carries an apostrophe rendered a line Ruby cannot parse.
  test("escapes a quote in a Mac App Store name", () => {
    expect(brewfileEntry({ kind: "mas", name: "Sam's App", id: "123" })).toBe(
      "mas 'Sam\\'s App', id: 123",
    );
  });
});

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "brew-drift");

const environment = { PATH: process.env.PATH };

let sandbox: string;
let stubs: string;
let root: string;
let argsFile: string;
let answerFile: string;

// Every stub answers the probe first, so an example can prove it is what a bare
// `brew` reaches before it lets the script spawn one. A stub that failed to
// shadow the real thing would run `brew bundle cleanup` against this machine.
const PROBE = [
  "#!/bin/sh",
  `[ "$1" = "--brew-drift-probe" ] && { printf 'stub\\n'; exit 0; }`,
  `printf '%s\\n' "$@" >"$BREW_ARGS"`,
  "",
].join("\n");

// Reproduces both halves of `brew bundle cleanup`: it prints the listing, then
// asks whether to uninstall. Whatever it reads is what a person's "y" would
// have been, recorded to a file because the answer never reaches stdout.
const LISTING_THEN_PROMPT = [
  `printf 'Would uninstall formulae:\\ncmake\\n'`,
  `read -r answer && printf '%s' "$answer" >"$BREW_ANSWER"`,
  "exit 1",
  "",
].join("\n");

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "brew-drift-"));
  stubs = join(sandbox, "stub");
  root = join(sandbox, "dotfiles");
  argsFile = join(sandbox, "args");
  answerFile = join(sandbox, "answer");
  mkdirSync(stubs);
  mkdirSync(root);
  writeFileSync(join(root, "Brewfile"), "");

  // Nothing but the stubs is reachable, so a call that escapes one finds no
  // brew at all rather than this machine's.
  process.env.PATH = stubs;
  process.env.BREW_ARGS = argsFile;
  process.env.BREW_ANSWER = answerFile;
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  delete process.env.BREW_ARGS;
  delete process.env.BREW_ANSWER;
  rmSync(sandbox, { recursive: true, force: true });
});

function stubBrew(body: string): void {
  const path = join(stubs, "brew");
  writeFileSync(path, PROBE + body);
  chmodSync(path, 0o755);

  const probe = Bun.spawnSync({
    cmd: ["brew", "--brew-drift-probe"],
    env: process.env,
    stdin: "ignore",
  });
  if (probe.stdout.toString().trim() !== "stub") {
    throw new Error(`brew resolved to ${Bun.which("brew", { PATH: process.env.PATH })}`);
  }
}

function removeBrewFromPath(): void {
  const empty = join(sandbox, "empty");
  mkdirSync(empty);
  process.env.PATH = empty;
}

function cleanupArgs(): string[] {
  return readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
}

function promptAnswer(): string {
  try {
    return readFileSync(answerFile, "utf8");
  } catch {
    return "unanswered";
  }
}

describe("run", () => {
  test.each<{ name: string; brew?: string; expected: Outcome }>([
    // The listing is the signal. Cleanup exits nonzero whenever it printed one
    // it could not act on, which is the normal result of a run that found
    // something, so a finding still exits 0.
    {
      name: "reports the packages a cleanup listing names before exiting nonzero",
      brew: LISTING_THEN_PROMPT,
      expected: { status: 0, stdout: "brew 'cmake'\n", stderr: "" },
    },
    {
      name: "stays silent when the machine matches the Brewfile",
      brew: "printf 'Using cmake\\n'\nexit 0\n",
      expected: { status: 0, stdout: "", stderr: "" },
    },
    // Empty output is a failure only when the status says the run went wrong.
    {
      name: "stays silent when a successful cleanup prints nothing",
      brew: "exit 0\n",
      expected: { status: 0, stdout: "", stderr: "" },
    },
    {
      name: "fails loudly when the cleanup produces nothing to read",
      brew: "exit 1\n",
      expected: { status: 1, stdout: "", stderr: `${NO_OUTPUT_DIAGNOSTIC}\n` },
    },
    // Resolving brew on PATH is what lets this run on Linux and in CI.
    {
      name: "reports nothing when brew is absent",
      expected: { status: 0, stdout: "", stderr: "" },
    },
  ])("$name", ({ brew, expected }) => {
    if (brew === undefined) removeBrewFromPath();
    else stubBrew(brew);

    expect(run([root])).toEqual(expected);
  });

  // --force is what turns cleanup into an uninstall, so its absence is the
  // difference between a report and a machine losing packages overnight.
  test.each<{ name: string; args: () => string[]; expected: () => string }>([
    {
      name: "points cleanup at the given root and never passes --force",
      args: () => [root],
      expected: () => `${root}/Brewfile`,
    },
    {
      name: "defaults the root to the repository root",
      args: () => [],
      expected: () => `${REPO_ROOT}/Brewfile`,
    },
    {
      name: "treats an empty root argument as an absent one",
      args: () => [""],
      expected: () => `${REPO_ROOT}/Brewfile`,
    },
  ])("$name", ({ args, expected }) => {
    stubBrew("exit 0\n");

    run(args());
    expect(cleanupArgs()).toEqual(["bundle", "cleanup", "--file", expected()]);
  });

  test("prints usage without resolving brew", () => {
    const outcome = run(["--help"]);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("Usage: brew-drift [dotfiles-root]");
  });

  // Bun raises where the shell exited 127, and a brew that resolved and then
  // could not be run has produced nothing to read.
  test("reads a brew that cannot be run as a failed cleanup", () => {
    expect(cleanupListing(join(sandbox, "absent-brew"), root)).toEqual({
      output: "",
      failed: true,
    });
  });
});

describe("the executable", () => {
  function spawnDrift(stdin: Buffer | "ignore") {
    return Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, root],
      env: process.env,
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  // Regression: without --force the command prompts rather than reporting, so a
  // run that leaves stdin open is one keystroke from uninstalling every
  // undeclared package. Only a real process can show that the child's stdin is
  // closed even when the script's own carries the answer.
  test("denies brew the stdin its uninstall prompt reads", () => {
    stubBrew(LISTING_THEN_PROMPT);

    const drift = spawnDrift(Buffer.from("y\n"));
    expect(drift.stdout.toString()).toBe("brew 'cmake'\n");
    expect(drift.exitCode).toBe(0);
    expect(promptAnswer()).toBe("unanswered");
  });

  // bin/dotfiles-upgrade captures the report through a pipe, where one write
  // takes only what the buffer holds and exiting drops whatever is queued
  // behind it.
  // Through a real pipeline, not Bun.spawnSync's own pipe. The nightly job runs
  // this under `2>&1 | tee`, where a `process.stdout.write` followed by
  // `process.exit` delivers exactly one 131072-byte buffer and drops the rest.
  // Reading the child directly would not show it: spawnSync drains as the child
  // writes and only truncates an order of magnitude further out, so a report
  // this size arrives whole even from an implementation that loses it under tee.
  test("writes a report longer than a pipe buffer in full", () => {
    const tokens = Array.from({ length: 20_000 }, (_, index) => `formula-${index}`);
    const path = join(sandbox, "listing");
    writeFileSync(path, listing("Would uninstall formulae:", ...tokens));
    // An absolute cat, because PATH holds nothing but the stub directory.
    stubBrew(`/bin/cat '${path}'\nexit 1\n`);

    const piped = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", `'${process.execPath}' '${SCRIPT}' '${root}' | /bin/cat`],
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = piped.stdout.toString().split("\n").filter(Boolean);
    expect(lines.length).toBe(tokens.length);
    expect(lines.at(-1)).toBe("brew 'formula-19999'");
  });

  // The caller reads stdout with $() and would file anything printed there as a
  // finding, so the diagnostic has to leave it empty.
  // A cleanup that failed after printing nothing but blank lines has told us
  // nothing, and the shell this replaced read the listing with $(), which strips
  // trailing newlines, so it took the diagnostic too.
  test("treats a listing of only blank lines as no output", () => {
    stubBrew("printf '\\n\\n\\n'\nexit 1\n");

    const drift = spawnDrift("ignore");
    expect(drift.exitCode).toBe(1);
    expect(drift.stdout.toString()).toBe("");
    expect(drift.stderr.toString()).toBe(`${NO_OUTPUT_DIAGNOSTIC}\n`);
  });

  test("carries the diagnostic on stderr and leaves stdout empty", () => {
    stubBrew("exit 1\n");

    const drift = spawnDrift("ignore");
    expect(drift.exitCode).toBe(1);
    expect(drift.stdout.toString()).toBe("");
    expect(drift.stderr.toString()).toBe(`${NO_OUTPUT_DIAGNOSTIC}\n`);
  });
});
