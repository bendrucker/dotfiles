import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  THINGS_NOTES_LIMIT,
  buildNotes,
  elisionMarker,
  latchValue,
  notificationScript,
  notify,
  readLatch,
  reportFailure,
  reportSuccess,
  statusFile,
  thingsAddUrl,
  trimOutput,
} from "./report-failure.ts";

let sandbox: string;
const environment = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };

function writeStub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "report-failure-"));
  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);

  // `open` is the only way a to-do is created, so recording the URL it was handed
  // is the whole observation: a line means a to-do was filed, no line means the
  // latch held.
  writeStub(join(stubs, "open"), `printf '%s\\n' "$1" >> "${join(sandbox, "todos")}"`);
  writeStub(join(stubs, "osascript"), `printf '%s\\n' "$2" >> "${join(sandbox, "notifications")}"`);
  writeStub(join(stubs, "gum"), "exit 0");

  // Nothing but the stubs is reachable, so a call that escapes one fails loudly
  // instead of reaching Things or the notification centre.
  process.env.PATH = stubs;
  process.env.XDG_STATE_HOME = join(sandbox, "state");

  // A stub that failed to shadow the real command would file real Things to-dos
  // and raise real notifications, so prove the shadowing before every example
  // rather than discovering it from the Today list.
  Bun.spawnSync({ cmd: ["open", "stub-probe"], env: process.env });
  const probed = readFileSync(join(sandbox, "todos"), "utf8");
  if (!probed.startsWith("stub-probe")) throw new Error(`open resolved to ${probed}`);
  rmSync(join(sandbox, "todos"));
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  if (environment.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = environment.XDG_STATE_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

function fail(output: string, fingerprint = ""): number {
  return reportFailure({
    job: "drift",
    title: "Stale",
    command: "audit",
    output,
    revision: "abc123",
    extraMeta: "",
    outputHeading: "Findings",
    fingerprint,
  });
}

function todos(): string[] {
  try {
    return readFileSync(join(sandbox, "todos"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function notifications(): string[] {
  try {
    return readFileSync(join(sandbox, "notifications"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function filedNotes(): string {
  const url = todos().at(-1) ?? "";
  return decodeURIComponent(url.split("&notes=")[1].split("&")[0]);
}

// The latch is the whole point of the file: a job that files a to-do every night
// trains you to ignore it, and one that files none after the first leaves later
// breakage silent.
describe("reportFailure latch", () => {
  test("files a to-do on the first failure", () => {
    expect(fail("one plugin stale")).toBe(0);
    expect(todos()).toHaveLength(1);
  });

  test("stays quiet while the job keeps failing the same way", () => {
    fail("one plugin stale");
    fail("one plugin stale");
    expect(todos()).toHaveLength(1);
  });

  test("files again after reportSuccess clears the latch", () => {
    fail("one plugin stale");
    reportSuccess("drift");
    fail("one plugin stale");
    expect(todos()).toHaveLength(2);
  });

  test("records ok on success and the failure state on a failure", () => {
    reportSuccess("drift");
    expect(readFileSync(statusFile("drift"), "utf8")).toBe("ok\n");
    fail("one plugin stale", "alpha");
    expect(readFileSync(statusFile("drift"), "utf8")).toBe("failed alpha\n");
  });

  test("reads a missing latch as the empty string", () => {
    expect(readLatch("never-run")).toBe("");
  });

  test("keeps the latch it wrote when the filing itself fails", () => {
    writeStub(join(sandbox, "stub", "open"), "exit 3");
    expect(fail("one plugin stale")).toBe(3);
    expect(readLatch("drift")).toBe("failed");
  });
});

// Without this, the first plugin to go stale suppresses every plugin that goes
// stale afterwards, for as long as the first one stays broken.
describe("reportFailure fingerprint", () => {
  test("files again when the findings change", () => {
    fail("alpha stale", "alpha");
    fail("alpha stale, beta stale", "alpha-beta");
    expect(todos()).toHaveLength(2);
  });

  test("stays quiet when the findings are unchanged", () => {
    fail("alpha stale", "alpha");
    fail("alpha stale", "alpha");
    expect(todos()).toHaveLength(1);
  });

  test("stays quiet for a fingerprint whose text ends in a newline", () => {
    fail("alpha stale", "alpha\n");
    fail("alpha stale", "alpha\n");
    expect(todos()).toHaveLength(1);
  });

  test("treats an empty fingerprint as no fingerprint", () => {
    expect(latchValue("")).toBe("failed");
    expect(latchValue("alpha")).toBe("failed alpha");
  });
});

// Things stores 10,000 characters of notes and drops the rest. claude-upgrade
// opens its log with a repository sync whose diffstat alone ran past that, and
// filed to-dos holding the diffstat and none of the error that ended the run.
describe("trimOutput", () => {
  const longLog = `${Array.from({ length: 20 }, (_, i) => `drop-${String(i + 1).padStart(2, "0")}`).join("\n")}\nkeep me`;

  test("leaves an output that already fits alone", () => {
    expect(trimOutput("short log", 100)).toBe("short log");
  });

  test("keeps the end of an output that does not fit", () => {
    const trimmed = trimOutput(longLog, 60);
    expect(trimmed).toContain("keep me");
    expect(trimmed).not.toContain("drop-01");
  });

  test("says how much it dropped", () => {
    expect(trimOutput(longLog, 60)).toContain("characters elided");
  });

  // A cut taken at the budget alone lands mid-line, and the note then opens on the
  // tail end of a word.
  test("resumes at a line boundary rather than mid-word", () => {
    const padded = Array.from(
      { length: 20 },
      (_, i) => `line-${String(i + 1).padStart(2, "0")}-padding`,
    ).join("\n");
    const [marker, resumed] = trimOutput(padded, 100).split("\n");
    expect(marker).toContain("characters elided");
    expect(resumed.startsWith("line-")).toBe(true);
  });

  // The motivating log ends in one long unwrapped error line, which leaves no
  // newline inside the budget to resume at.
  test("resumes at a word boundary inside a line longer than the budget", () => {
    const unwrapped = `short${Array.from({ length: 40 }, (_, i) => ` word-${String(i + 1).padStart(3, "0")}`).join("")}`;
    expect(trimOutput(unwrapped, 60).split("\n")[1].startsWith("word-")).toBe(true);
  });

  // The marker is what says the log was cut, and it spends budget of its own. A
  // budget too small for it overran the note it was measured to fit inside.
  test("yields nothing when the budget cannot hold the marker", () => {
    expect(trimOutput(longLog, 10)).toBe("");
  });

  test("never exceeds the budget it was given", () => {
    for (const budget of [0, 1, 31, 32, 40, 60, 166]) {
      expect(trimOutput(longLog, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  // The count is taken after the boundary strip, so it covers the characters that
  // strip discarded as well.
  test("counts what it dropped against the whole output", () => {
    const trimmed = trimOutput(longLog, 60);
    const kept = trimmed.split("\n").slice(1).join("\n");
    expect(trimmed.split("\n")[0]).toBe(elisionMarker(longLog.length - kept.length, longLog.length));
  });

  // The blank lines a log ends in never reach the note, because the closing fence
  // sits directly after the last log line. A marker that does not count them says
  // the note lost fewer characters than it did.
  test("counts the trailing blank lines it drops", () => {
    const output = `${longLog}\n\n\n`;
    const trimmed = trimOutput(output, 60);
    const [marker, ...rest] = trimmed.split("\n");
    const kept = rest.join("\n");
    expect(trimmed.endsWith("\n")).toBe(false);
    expect(marker).toBe(elisionMarker(output.length - kept.length, output.length));
  });

  // A cut between the halves of a surrogate pair leaves an orphaned code unit that
  // renders as a replacement character.
  test("does not open the kept text on half a surrogate pair", () => {
    const emoji = "🙂".repeat(200);
    const trimmed = trimOutput(emoji, 100);
    expect(trimmed.split("\n")[1]).not.toMatch(/^[\uDC00-\uDFFF]/);
  });
});

describe("buildNotes", () => {
  const note = {
    host: "eucalyptus",
    time: "2026-09-05 03:00:12 PDT",
    revision: "abc123",
    extraMeta: "",
    command: "brew bundle",
    outputHeading: "Error Output",
    output: "boom",
  };

  test("opens with the host, time and revision", () => {
    expect(buildNotes(note)).toStartWith(
      "- **Host:** eucalyptus\n- **Time:** 2026-09-05 03:00:12 PDT\n- **Revision:** abc123\n\n",
    );
  });

  test("appends extra metadata to the header only when there is some", () => {
    expect(buildNotes(note)).not.toContain("- **Claude:**");
    expect(buildNotes({ ...note, extraMeta: "- **Claude:** 2.0" })).toContain(
      "- **Revision:** abc123\n- **Claude:** 2.0\n\n",
    );
  });

  test("fences the reproduction command and names the output section", () => {
    expect(buildNotes(note)).toContain("```sh\nbrew bundle\n```\n\n## Error Output\n```\nboom\n```");
  });

  test("closes the fence on the line after the last log line", () => {
    expect(buildNotes({ ...note, output: "boom\n\n\n" })).toEndWith("boom\n```");
  });

  test("counts the blank lines the closing fence displaces as dropped", () => {
    const output = `${"padding line\n".repeat(800)}\n\n`;
    const notes = buildNotes({ ...note, output });
    const marker = notes.match(/\[(\d+) of (\d+) characters elided\]/);
    if (!marker) throw new Error("no elision marker in the note");
    const kept = notes.slice(notes.indexOf(marker[0]) + marker[0].length + 1, -"\n```".length);
    expect(Number(marker[2])).toBe(output.length);
    expect(Number(marker[1]) + kept.length).toBe(output.length);
  });

  // The regression: the error is the last line, and it was the part Things cut.
  test("keeps the note within what Things stores and keeps the error that ended the run", () => {
    const big = `${" plugins/some/path.ts | 12 ++++\n".repeat(400)}WARN the actual failure\n`;
    const notes = buildNotes({ ...note, output: big });
    expect(notes.length).toBeLessThanOrEqual(THINGS_NOTES_LIMIT);
    expect(notes).toContain("WARN the actual failure");
  });
});

describe("thingsAddUrl", () => {
  test("files the to-do for today", () => {
    expect(thingsAddUrl("Stale", "notes")).toBe(
      "things:///add?title=Stale&notes=notes&when=today",
    );
  });

  // The fields have to survive being read back out of the URL, which means neither
  // may leave a literal & or % behind to split it apart.
  test("percent-encodes everything outside the unreserved set", () => {
    const url = thingsAddUrl("a&b (c) %d!", "e&f'g*h");
    expect(url.split("&")).toHaveLength(3);
    expect(url).toContain("title=a%26b%20%28c%29%20%25d%21");
    expect(url).toContain("notes=e%26f%27g%2Ah");
  });

  test("round-trips a note through the URL", () => {
    const notes = "a & b\n100% done\n\"quoted\"";
    fail("boom");
    expect(decodeURIComponent(thingsAddUrl("t", notes).split("&notes=")[1].split("&")[0])).toBe(
      notes,
    );
  });
});

describe("reportFailure note", () => {
  test("carries the trimmed log into the filed to-do", () => {
    const big = `${" plugins/some/path.ts | 12 ++++\n".repeat(400)}WARN the actual failure\n`;
    fail(big);
    const notes = filedNotes();
    expect(notes.length).toBeLessThanOrEqual(THINGS_NOTES_LIMIT);
    expect(Buffer.byteLength(notes)).toBeLessThanOrEqual(THINGS_NOTES_LIMIT);
    expect(notes).toContain("WARN the actual failure");
    expect(notes).toContain("## Findings");
  });
});

describe("notificationScript", () => {
  test("names the message, title and sound", () => {
    expect(notificationScript("Dotfiles Sync", "Updated to abc123", "Glass")).toBe(
      'display notification "Updated to abc123" with title "Dotfiles Sync" sound name "Glass"',
    );
  });

  // Titles are built by interpolation at the call sites, and an invalid script
  // fails silently, so the notification would simply never appear.
  test("escapes quotes and backslashes so a caller cannot break the script", () => {
    expect(notificationScript('a "b" c', "back\\slash", "Basso")).toBe(
      'display notification "back\\\\slash" with title "a \\"b\\" c" sound name "Basso"',
    );
  });
});

// The notification is the only part of a failure report that reaches someone who
// is not reading the Things list, and osascript discards its own errors, so a
// broken call would go unnoticed on the one platform that has it.
describe("notify", () => {
  test("hands osascript the script for the notification", () => {
    notify("Dotfiles Sync", "Updated to abc123", "Glass");
    expect(notifications()).toEqual([
      'display notification "Updated to abc123" with title "Dotfiles Sync" sound name "Glass"',
    ]);
  });

  test("defaults the sound", () => {
    notify("Dotfiles Sync", "Updated to abc123");
    expect(notifications()[0]).toContain('sound name "Basso"');
  });

  // Every Linux run reaches this, CI included, under callers that abort on a
  // nonzero status.
  test("does nothing where osascript is absent", () => {
    process.env.PATH = join(sandbox, "empty");
    expect(() => notify("Dotfiles Sync", "Updated to abc123")).not.toThrow();
    expect(notifications()).toEqual([]);
  });

  test("notifies alongside the to-do it files", () => {
    fail("one plugin stale");
    expect(notifications()[0]).toContain('display notification "drift failed - see Things to-do"');
  });
});

// The five shell callers reach the CLI through the shim, which is where a value is
// turned into a command line. bin/claude-upgrade's extra metadata opens with a
// markdown bullet, and a captured log opens with whatever the failing command
// wrote, so a value that reads as a flag is the ordinary case rather than an odd
// one.
describe("shim", () => {
  const shim = join(import.meta.dir, "report-failure.sh");

  // The shim finds the CLI relative to itself and the CLI runs under bun, so the
  // stubs go in front of a real PATH rather than replacing it.
  function sourced(script: string): number {
    return Bun.spawnSync({
      cmd: ["bash", "-c", `. ${JSON.stringify(shim)}\n${script}`],
      env: {
        ...process.env,
        PATH: [join(sandbox, "stub"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    }).exitCode;
  }

  test("carries metadata that opens with a dash into the filed to-do", () => {
    const status = sourced(
      "report_failure drift Stale audit boom abc123 '- **Claude:** 2.0.1' Findings deadbeef",
    );
    expect(status).toBe(0);
    expect(todos()).toHaveLength(1);
    expect(filedNotes()).toContain("- **Claude:** 2.0.1");
  });

  test("carries a log that opens with a dash into the filed to-do", () => {
    expect(sourced("report_failure drift Stale audit '-- stderr --' abc123")).toBe(0);
    expect(filedNotes()).toContain("-- stderr --");
  });
});
