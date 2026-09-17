import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { causeFingerprint, causeOf, distinctiveLine, normalizeVolatile } from "#jobs/cause";

const ESC = "\u001b";

let home: string | undefined;

beforeEach(() => {
  home = process.env.HOME;
  process.env.HOME = "/Users/someone";
});

afterEach(() => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
});

// Trimmed from the run the two Studio to-dos were filed against,
// dotfiles-upgrade-68b40361f090.log: a herdr plugin sync narrating a clean
// tally partway through an install that went on to die in a topic installer.
const INSTALL_RUN = [
  "-- prune --",
  "pruned 0 plugin(s)",
  "",
  "summary: 10 present, 0 installed, 0 failed, 10 desired total",
  "lock unchanged -> /Users/ben/.dotfiles/herdr/plugins.lock",
  "\u2192 chmouel/gh-news @ v0.18.0",
  "[news]: already up to date",
  "./activitywatch/install.sh: line 68: /Users/ben/.dotfiles/macos/lib/launch-agent.sh: No such file or directory",
].join("\n");

describe("distinctiveLine", () => {
  test("takes the line that reports a failure", () => {
    const output = ["Fetching origin", "fatal: could not read Username", "exit 128"].join("\n");
    expect(distinctiveLine(output)).toBe("fatal: could not read Username");
  });

  // Reading from the front handed the cause of a whole install to the first
  // step that said a word like "failed", which was a plugin sync that had
  // succeeded. The install died six steps later, and that is where it broke.
  test("takes the last line that reports a failure", () => {
    expect(distinctiveLine(INSTALL_RUN)).toBe(
      "./activitywatch/install.sh: line 68: /Users/ben/.dotfiles/macos/lib/launch-agent.sh: No such file or directory",
    );
  });

  // "0 failed" is the vocabulary without the event.
  test("does not read a tally of nothing gone wrong as a failure", () => {
    const output = ["compiling", "summary: 1 updated, 0 pinned, 0 failed"].join("\n");
    expect(distinctiveLine(output)).toBe("summary: 1 updated, 0 pinned, 0 failed");
    expect(distinctiveLine(`error: bad object\n${output}`)).toBe("error: bad object");
  });

  test("still reads a line reporting a zero and a real failure", () => {
    expect(distinctiveLine("0 errors, 1 failure")).toBe("0 errors, 1 failure");
  });

  // The job's own narration says which step broke, which the job name already
  // says. Keying on it collapsed every break in a step into one to-do.
  test("skips the lines this repo's own scripts logged", () => {
    const output = ["ERRO Syncing dotfiles failed", "error: cannot lock ref"].join("\n");
    expect(distinctiveLine(output)).toBe("error: cannot lock ref");
  });

  // A child that died without a recognizable diagnosis still stopped where it
  // broke, so the end of its output is the best evidence available.
  test("falls back to the last line when nothing announces a failure", () => {
    expect(distinctiveLine("compiling\nlinking\n")).toBe("linking");
  });

  test("reads through the colour escapes a child wrote", () => {
    expect(distinctiveLine(`${ESC}[31mfatal${ESC}[0m: bad object\n`)).toBe("fatal: bad object");
  });

  test("has nothing to say about an empty log", () => {
    expect(distinctiveLine("\n \n")).toBe("");
  });
});

// Every one of these is a span that differs between two runs of one unchanged
// failure, and each is why a to-do was filed a second time for a cause already
// standing.
describe("normalizeVolatile", () => {
  test.each<{ name: string; line: string; normalized: string }>([
    {
      name: "a duration",
      line: "failed after 30012 ms",
      normalized: "failed after <duration>",
    },
    { name: "a timestamp", line: "at 2026-09-11T03:00:04Z", normalized: "at <time>" },
    {
      name: "a bare date",
      line: "since 2026-09-11 fell behind",
      normalized: "since <date> fell behind",
    },
    { name: "a git object name", line: "bad object 4f2a9c1b8e", normalized: "bad object <hex>" },
    { name: "a byte count", line: "only 4.2 MB free", normalized: "only <size> free" },
    {
      // The two machines share the tilde and nothing after the user name.
      name: "the home directory",
      line: "cannot read /Users/someone/.dotfiles/x",
      normalized: "cannot read ~/.dotfiles/x",
    },
  ])("replaces $name", ({ line, normalized }) => {
    expect(normalizeVolatile(line)).toBe(normalized);
  });
});

describe("causeFingerprint", () => {
  const resolve = "fatal: unable to access 'https://github.com/x': Could not resolve host";

  test("holds still across two runs of one unchanged failure", () => {
    const monday = `ERRO sync failed\n${resolve}, after 3012 ms\n`;
    const tuesday = `ERRO sync failed\n${resolve}, after 41 ms\n`;
    expect(causeFingerprint("dotfiles-sync", monday)).toBe(causeFingerprint("dotfiles-sync", tuesday));
  });

  test("moves when the step breaks a different way", () => {
    const resolveHost = causeFingerprint("dotfiles-sync", `${resolve}\n`);
    const lockRef = causeFingerprint("dotfiles-sync", "error: cannot lock ref 'HEAD'\n");
    expect(resolveHost).not.toBe(lockRef);
  });

  test("separates two commands that fail with the same line", () => {
    expect(causeFingerprint("scripts/install", "error: boom\n")).not.toBe(
      causeFingerprint("dotfiles-sync", "error: boom\n"),
    );
  });
});

describe("causeOf", () => {
  test("is stable for the same parts and differs for different ones", () => {
    expect(causeOf(["alpha stale"])).toBe(causeOf(["alpha stale"]));
    expect(causeOf(["alpha stale"])).not.toBe(causeOf(["beta stale"]));
  });

  test("keeps two hex fingerprints apart", () => {
    // normalizeVolatile reads any 7+ hex run as one <hex>, which collapsed every
    // caller that hands over a digest into a single cause: bin/claude-sync files
    // on the sha1 of which plugins failed, so one to-do covered all of them.
    expect(causeOf(["9f8e7d6c5b4a"])).not.toBe(causeOf(["1a2b3c4d5e6f"]));
  });
});
