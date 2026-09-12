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

describe("distinctiveLine", () => {
  test("takes the first line that reports a failure", () => {
    const output = ["Fetching origin", "fatal: could not read Username", "exit 128"].join("\n");
    expect(distinctiveLine(output)).toBe("fatal: could not read Username");
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
  test("replaces a duration", () => {
    expect(normalizeVolatile("failed after 30012 ms")).toBe("failed after <duration>");
  });

  test("replaces a timestamp and a bare date", () => {
    expect(normalizeVolatile("at 2026-09-11T03:00:04Z")).toBe("at <time>");
    expect(normalizeVolatile("since 2026-09-11 fell behind")).toBe("since <date> fell behind");
  });

  test("replaces a git object name", () => {
    expect(normalizeVolatile("bad object 4f2a9c1b8e")).toBe("bad object <hex>");
  });

  test("replaces a byte count", () => {
    expect(normalizeVolatile("only 4.2 MB free")).toBe("only <size> free");
  });

  test("reduces the home directory to a tilde, which is what the two machines share", () => {
    expect(normalizeVolatile("cannot read /Users/someone/.dotfiles/x")).toBe(
      "cannot read ~/.dotfiles/x",
    );
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

  test("normalizes its parts, so a volatile span cannot refile a standing cause", () => {
    expect(causeOf(["stale as of 2026-09-11"])).toBe(causeOf(["stale as of 2026-09-12"]));
  });
});
