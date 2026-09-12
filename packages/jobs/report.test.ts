import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ESCALATE_AFTER,
  appendBlock,
  buildNotes,
  causeMarker,
  elisionMarker,
  type Finding,
  decideFindings,
  latchValue,
  notificationScript,
  notify,
  reportFailure,
  reportFindings,
  reportSuccess,
  todoTitle,
  trimOutput,
} from "#jobs/report";
import { readLatch, statusFile } from "#jobs/state";
import { THINGS_NOTES_LIMIT } from "#jobs/things";

let sandbox: string;
const environment = {
  PATH: process.env.PATH,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  THINGS_DATABASE: process.env.THINGS_DATABASE,
};

function writeStub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function stub(name: string): string {
  return join(sandbox, "stub", name);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "jobs-report-"));
  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);

  // `open` is the only way a to-do is created or changed, so recording the URL it
  // was handed is the whole observation. `-g` puts the URL in the second
  // argument.
  writeStub(join(stubs, "open"), `printf '%s\\n' "$2" >> "${join(sandbox, "urls")}"`);
  writeStub(join(stubs, "osascript"), `printf '%s\\n' "$2" >> "${join(sandbox, "notifications")}"`);
  writeStub(join(stubs, "gum"), "exit 0");
  // Nothing can be appended without the token, so the default is the machine that has one.
  writeStub(join(stubs, "security"), 'printf "token-abc\\n"');

  // Nothing but the stubs is reachable, so a call that escapes one fails loudly
  // instead of reaching Things or the notification centre.
  process.env.PATH = stubs;
  process.env.XDG_STATE_HOME = join(sandbox, "state");
  // Pointed at nothing by default, which is a machine where Things cannot be
  // read: the latch alone decides.
  process.env.THINGS_DATABASE = join(sandbox, "absent.sqlite");

  // A stub that failed to shadow the real command would file real Things to-dos
  // and raise real notifications, so prove the shadowing before every example
  // rather than discovering it from the Today list.
  Bun.spawnSync({ cmd: ["open", "-g", "stub-probe"], env: process.env });
  const probed = readFileSync(join(sandbox, "urls"), "utf8");
  if (!probed.startsWith("stub-probe")) throw new Error(`open resolved to ${probed}`);
  rmSync(join(sandbox, "urls"));
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  for (const key of ["XDG_STATE_HOME", "THINGS_DATABASE"] as const) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
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

function urls(): string[] {
  try {
    return readFileSync(join(sandbox, "urls"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function added(): string[] {
  return urls().filter((url) => url.startsWith("things:///add"));
}

function updated(): string[] {
  return urls().filter((url) => url.startsWith("things:///update"));
}

function field(url: string, name: string): string {
  const match = url.match(new RegExp(`[?&]${name}=([^&]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function notifications(): string[] {
  try {
    return readFileSync(join(sandbox, "notifications"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function filedNotes(): string {
  return field(added().at(-1) ?? "", "notes");
}

const SCHEMA =
  "create table if not exists TMTask (uuid text, title text, notes text," +
  " status integer, trashed integer, type integer, creationDate real)";

// Put the to-do that was just filed into the store, the way Things would have.
// The marker it carries is the one the reporter derived for this machine, so the
// next run has to recognize it without the test knowing the machine's key.
function standInThings(id = "todo-1", notes = filedNotes(), status = 0): void {
  const path = join(sandbox, "things.sqlite");
  process.env.THINGS_DATABASE = path;
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  // Things edits a to-do in place, so calling this again for one already in the
  // store has to replace it rather than leave the earlier version standing too.
  db.run("delete from TMTask where uuid = ?", [id]);
  db.run("insert into TMTask values (?, ?, ?, ?, ?, ?, ?)", [id, "Stale", notes, status, 0, 0, 1]);
  db.close();
}

// The latch is what answers on a machine where the Things store cannot be read.
// A job that files a to-do every night trains you to ignore it, and one that
// files none after the first leaves later breakage silent.
describe("reportFailure latch", () => {
  test("files a to-do on the first failure", () => {
    expect(fail("one plugin stale")).toBe(0);
    expect(added()).toHaveLength(1);
  });

  test("stays quiet while the job keeps failing the same way", () => {
    fail("one plugin stale");
    fail("one plugin stale");
    expect(added()).toHaveLength(1);
  });

  test("files again after reportSuccess clears the latch", () => {
    fail("one plugin stale");
    reportSuccess("drift");
    fail("one plugin stale");
    expect(added()).toHaveLength(2);
  });

  test("records ok on success and the cause on a failure", () => {
    reportSuccess("drift");
    expect(readFileSync(statusFile("drift"), "utf8")).toBe("ok\n");
    fail("one plugin stale", "alpha");
    expect(readFileSync(statusFile("drift"), "utf8")).toMatch(/^failed [0-9a-f]{12}\n$/);
  });

  test("reads a missing latch as the empty string", () => {
    expect(readLatch("never-run")).toBe("");
  });

  // A latch claiming a to-do that was never created silences the cause on every
  // later night the store cannot be read, which is every night on a machine
  // without Things.
  test("puts the latch back when the filing itself fails", () => {
    writeStub(stub("open"), "exit 3");
    // The filer's own status, which is what tells a refused filing apart from a
    // failure that was filed.
    expect(fail("one plugin stale")).toBe(3);
    expect(readLatch("drift")).toBe("");
  });

  test("treats an empty fingerprint as no fingerprint", () => {
    expect(latchValue("")).toBe("failed");
    expect(latchValue("alpha")).toBe("failed alpha");
  });
});

// The whole point of deriving a cause: one step can break many ways, and a latch
// keyed on the step alone filed the first and suppressed every different one
// behind it.
describe("reportFailure cause", () => {
  test("stays quiet when the same line fails again with a different duration", () => {
    fail("ERRO sync failed\nfatal: could not resolve host, after 3012 ms\n");
    fail("ERRO sync failed\nfatal: could not resolve host, after 44 ms\n");
    expect(added()).toHaveLength(1);
  });

  test("files again when the step breaks a different way", () => {
    fail("fatal: could not resolve host\n");
    fail("error: cannot lock ref 'HEAD'\n");
    expect(added()).toHaveLength(2);
  });

  test("honours a fingerprint the caller derived itself", () => {
    fail("alpha stale", "alpha");
    fail("beta stale", "alpha");
    expect(added()).toHaveLength(1);
    fail("beta stale", "beta");
    expect(added()).toHaveLength(2);
  });

  test("stays quiet for a fingerprint whose text ends in a newline", () => {
    fail("alpha stale", "alpha\n");
    fail("alpha stale", "alpha\n");
    expect(added()).toHaveLength(1);
  });
});

// Where a to-do lands, which is the half of this Ben reads every morning.
describe("reportFailure filing", () => {
  test("lands in Anytime rather than Today", () => {
    fail("boom");
    expect(field(added()[0], "when")).toBe("anytime");
  });

  test("carries the tag that gathers the set", () => {
    fail("boom");
    expect(field(added()[0], "tags")).toBe("dotfiles");
  });

  test("names the machine in the title, since the two of them fail independently", () => {
    fail("boom");
    expect(field(added()[0], "title")).toMatch(/^Stale on .+/);
  });

  test("notifies when the cause is new", () => {
    fail("boom");
    expect(notifications()).toHaveLength(1);
  });
});

describe("reportFailure append", () => {
  test("appends the run to the to-do already standing for the cause", () => {
    fail("boom");
    standInThings();

    expect(fail("boom")).toBe(0);
    expect(added()).toHaveLength(1);
    expect(updated()).toHaveLength(1);
    expect(field(updated()[0], "id")).toBe("todo-1");
    expect(field(updated()[0], "append-notes")).toContain("### Run 2");
  });

  // The two runs have to share a cause to reach the append at all, so they differ
  // below the line that names the failure rather than in it.
  test("carries the run's own output into the append", () => {
    fail("fatal: could not resolve host\nattempt one\n");
    standInThings();
    fail("fatal: could not resolve host\nattempt two\n");
    expect(field(updated()[0], "append-notes")).toContain("attempt two");
  });

  test("stays quiet rather than notifying again", () => {
    fail("boom");
    standInThings();
    fail("boom");
    expect(notifications()).toHaveLength(1);
  });

  test("counts the runs in the title, so a cause aging shows without being opened", () => {
    fail("boom");
    standInThings();
    fail("boom");
    expect(field(updated()[0], "title")).toMatch(/^Stale on .+ \(2 runs\)$/);
  });

  test("files a fresh to-do for a different cause while one stands", () => {
    fail("fatal: could not resolve host\n");
    standInThings();
    fail("error: cannot lock ref 'HEAD'\n");
    expect(added()).toHaveLength(2);
    expect(updated()).toHaveLength(0);
  });

  test("files again once the standing to-do has been completed", () => {
    fail("boom");
    standInThings("todo-1", filedNotes(), 3);
    fail("boom");
    expect(added()).toHaveLength(2);
  });

  // Without the token `update` is refused, and a to-do is already standing for
  // this cause. Filing a second one every night it repeats was the flood this
  // whole design exists to prevent, and nothing is lost by staying quiet: the
  // archive holds every run, and the standing note names the archive.
  test("leaves the standing to-do alone where the append cannot be made", () => {
    fail("boom");
    standInThings();
    writeStub(stub("security"), "exit 1");

    fail("boom");
    fail("boom");
    fail("boom");

    expect(added()).toHaveLength(1);
  });

  // The latch moves before the filing, so a filing Things refused puts it back.
  // A later night that cannot read the store would otherwise read the latch as a
  // to-do standing and leave the failure unreported for good.
  test("puts the latch back where the filing was refused", () => {
    writeStub(stub("open"), "exit 1");
    fail("boom");
    expect(added()).toHaveLength(0);

    writeStub(stub("open"), `printf '%s\\n' "$2" >> "${join(sandbox, "urls")}"`);
    fail("boom");

    expect(added()).toHaveLength(1);
  });

  // A recovery clears the latch while the to-do it filed stays standing, so the
  // append has to put the cause back. Otherwise a later night that cannot read
  // the store reads the stale latch and files what it is blind to.
  test("re-latches a cause returning to a to-do that still stands", () => {
    fail("boom");
    standInThings();
    reportSuccess("drift");
    fail("boom");

    process.env.THINGS_DATABASE = join(sandbox, "unreadable.sqlite");
    fail("boom");

    expect(added()).toHaveLength(1);
  });

  // A to-do standing for a different cause is not one this failure can append to.
  test("still files where nothing stands for this cause", () => {
    writeStub(stub("security"), "exit 1");
    fail("fatal: could not resolve host\n");
    standInThings();
    fail("error: cannot lock ref 'HEAD'\n");
    expect(added()).toHaveLength(2);
  });
});

// Today is the working list. A cause that has outlived three runs is no longer
// something to look at when convenient.
describe("reportFailure escalation", () => {
  function repeat(times: number): void {
    fail("boom");
    for (let run = 2; run <= times; run += 1) {
      standInThings();
      fail("boom");
    }
  }

  test("leaves a cause in Anytime while it is young", () => {
    repeat(2);
    expect(field(updated().at(-1) ?? "", "when")).toBe("");
  });

  test("moves a cause to Today once it has survived the threshold", () => {
    repeat(ESCALATE_AFTER);
    expect(field(updated().at(-1) ?? "", "when")).toBe("today");
  });

  // Ben pulling it back out of Today is a decision the next run leaves standing.
  test("does not move it again on the runs after that", () => {
    repeat(ESCALATE_AFTER + 1);
    expect(field(updated().at(-1) ?? "", "when")).toBe("");
  });

  // A night the store cannot be read records its run without appending, so the
  // count steps over the threshold rather than landing on it. Testing for
  // equality there lost the escalation for good.
  test("escalates on the first append past a threshold the count stepped over", () => {
    repeat(ESCALATE_AFTER - 1);
    process.env.THINGS_DATABASE = join(sandbox, "unreadable.sqlite");
    fail("boom");

    standInThings();
    fail("boom");

    expect(field(updated().at(-1) ?? "", "title")).toMatch(/\(4 runs\)$/);
    expect(field(updated().at(-1) ?? "", "when")).toBe("today");
  });

  // The claim is taken before the update that would carry it, so an update
  // Things refuses hands it back. Spending the one move on an edit that never
  // landed leaves the cause in Anytime for good.
  test("keeps the escalation where the update carrying it fails", () => {
    repeat(ESCALATE_AFTER - 1);
    writeStub(stub("security"), "exit 1");
    standInThings();
    fail("boom");

    writeStub(stub("security"), 'printf "token-abc\\n"');
    standInThings();
    fail("boom");

    expect(field(updated().at(-1) ?? "", "when")).toBe("today");
  });

  // The run count that decides this is the standing to-do's, not the archive's.
  // Counting every run the cause ever had leaves the replacement starting above
  // the threshold, so it walks past it and never reaches Today again.
  test("escalates the to-do that replaces a completed one on its own third run", () => {
    repeat(ESCALATE_AFTER);
    standInThings("todo-1", filedNotes(), 3);

    fail("boom");
    expect(field(added().at(-1) ?? "", "title")).toMatch(/^Stale on [^(]+$/);

    standInThings("todo-2");
    fail("boom");
    standInThings("todo-2");
    fail("boom");

    expect(field(updated().at(-1) ?? "", "id")).toBe("todo-2");
    expect(field(updated().at(-1) ?? "", "title")).toMatch(/\(3 runs\)$/);
    expect(field(updated().at(-1) ?? "", "when")).toBe("today");
  });
});

describe("todoTitle", () => {
  test("names the machine, and the run count only once there is more than one", () => {
    expect(todoTitle("Stale", "Studio", 1)).toBe("Stale on Studio");
    expect(todoTitle("Stale", "Studio", 4)).toBe("Stale on Studio (4 runs)");
  });
});

describe("causeMarker", () => {
  test("names the machine, the job and the cause", () => {
    expect(causeMarker("a1b2c3d4", "dotfiles-sync", "9f8e")).toBe(
      "dotfiles-job a1b2c3d4/dotfiles-sync/9f8e",
    );
  });
});

function finding(row: string): Finding {
  const [subject, verdict] = row.split(" ");
  return { subject, verdict };
}

// One night of a findings job: what stands, and what it could not reach a
// verdict on.
function night(standing: string[], held: string[] = []): number {
  return reportFindings({
    job: "drift",
    title: "Stale",
    command: "audit",
    output: standing.join("\n"),
    revision: "abc123",
    extraMeta: "",
    outputHeading: "Findings",
    standing: standing.map(finding),
    held,
  });
}

// The set-wide fingerprint this replaced re-filed every finding whenever any one
// of them joined or left, so a plugin that had been stale for a week filed a
// fresh to-do each time an unrelated one was fixed.
describe("reportFindings latch", () => {
  test("files a to-do for a newly standing finding", () => {
    night(["alpha stale"]);
    expect(added()).toHaveLength(1);
  });

  // A finding that left and came back has a to-do already standing for it, so an
  // append Things refuses leaves that one alone. The ordinary failure path
  // reaches the same answer through its latch, which this path does not carry.
  test("leaves the standing to-do alone where the append cannot be made", () => {
    night(["alpha stale"]);
    standInThings();
    writeStub(stub("security"), "exit 1");

    night([]);
    night(["alpha stale"]);

    expect(added()).toHaveLength(1);
  });

  test("stays quiet while the same finding stands", () => {
    night(["alpha stale"]);
    night(["alpha stale"]);
    expect(added()).toHaveLength(1);
  });

  test("stays quiet for a standing finding while the set churns around it", () => {
    night(["alpha stale"]);
    night(["alpha stale", "beta stale"]);
    night(["alpha stale"]);
    night(["alpha stale", "gamma pinned"]);
    // One each for beta and gamma, and none of the three later nights re-filed
    // alpha.
    expect(added()).toHaveLength(3);
    expect(filedNotes()).toContain("**New:** gamma pinned");
  });

  test("names only the newly standing findings", () => {
    night(["alpha stale", "beta stale"]);
    night(["alpha stale", "beta stale", "gamma orphaned"]);
    expect(filedNotes()).toContain("**New:** gamma orphaned");
  });

  test("files again when a subject's verdict changes", () => {
    night(["alpha stale"]);
    night(["alpha pinned"]);
    expect(added()).toHaveLength(2);
    expect(filedNotes()).toContain("**New:** alpha pinned");
  });

  test("files again after a finding is fixed and comes back", () => {
    night(["alpha stale"]);
    night([]);
    night(["alpha stale"]);
    expect(added()).toHaveLength(2);
  });

  test("keeps the latch it wrote when the filing itself fails", () => {
    writeStub(stub("open"), "exit 3");
    expect(night(["alpha stale"])).toBe(3);
    expect(readLatch("drift")).toBe("standing\nalpha\tstale");
  });

  test("keeps its latch clear of the single-failure one", () => {
    fail("alpha stale", "alpha");
    night(["alpha stale"]);
    night(["alpha stale"]);
    expect(added()).toHaveLength(2);
  });

  test("appends a returning finding set to the to-do standing for it", () => {
    night(["alpha stale"]);
    standInThings();
    night([]);
    night(["alpha stale"]);
    expect(added()).toHaveLength(1);
    expect(updated()).toHaveLength(1);
  });
});

// The audit reaches most plugins over the network, and at 3am an ls-remote loses
// to a flaky connection far more often than to a real change. A finding that
// disappears into that bucket has not been fixed, and treating it as fixed was a
// second route to the same duplicate to-do: it left the latch on the blip and
// re-filed as new the next night.
describe("reportFindings held subjects", () => {
  test("keeps a latched finding whose subject went unverified", () => {
    night(["alpha stale"]);
    night([], ["alpha"]);
    expect(readLatch("drift")).toBe("standing\nalpha\tstale");
    expect(added()).toHaveLength(1);
  });

  test("files nothing when a held finding comes back unchanged", () => {
    night(["alpha stale"]);
    night([], ["alpha"]);
    night(["alpha stale"]);
    expect(added()).toHaveLength(1);
  });

  test("files nothing for a subject that is only ever unverified", () => {
    night([], ["alpha"]);
    expect(added()).toHaveLength(0);
    expect(readLatch("drift")).toBe("standing");
  });

  test("clears a subject that is neither standing nor held", () => {
    night(["alpha stale", "beta stale"]);
    night(["alpha stale"], ["gamma"]);
    expect(readLatch("drift")).toBe("standing\nalpha\tstale");
  });
});

describe("decideFindings", () => {
  test("carries a held finding without calling it fresh", () => {
    const decision = decideFindings([finding("alpha stale")], [], ["alpha"]);
    expect(decision.fresh).toEqual([]);
    expect(decision.latched).toEqual([finding("alpha stale")]);
  });

  test("drops a finding that came back clean", () => {
    const decision = decideFindings([finding("alpha stale")], [], []);
    expect(decision.latched).toEqual([]);
  });

  test("reports every standing finding as fresh against an empty latch", () => {
    const decision = decideFindings([], [finding("alpha stale"), finding("beta pinned")], []);
    expect(decision.fresh).toHaveLength(2);
  });
});

// Things stores 10,000 characters of notes and drops the rest. claude-sync opens
// its log with a repository sync whose diffstat alone ran past that, and the
// error that ended the run was the part cut.
describe("trimOutput", () => {
  test("keeps a log that fits", () => {
    expect(trimOutput("short", 100)).toBe("short");
  });

  test("keeps the end of a log that does not", () => {
    const output = `${"line\n".repeat(100)}the failure`;
    const trimmed = trimOutput(output, 60);
    expect(trimmed.length).toBeLessThanOrEqual(60);
    expect(trimmed).toEndWith("the failure");
  });

  test("says how much it dropped", () => {
    const output = `${"line\n".repeat(100)}the failure`;
    expect(trimOutput(output, 60)).toContain("characters elided]");
  });

  test("resumes at a line boundary", () => {
    const output = `${"line\n".repeat(100)}the failure`;
    const kept = trimOutput(output, 60).split("\n").slice(1);
    expect(kept.every((line) => line === "line" || line === "the failure")).toBe(true);
  });

  test("resumes at a word boundary inside a line longer than the budget", () => {
    const output = `${"word ".repeat(200)}end`;
    const trimmed = trimOutput(output, 60);
    expect(trimmed.split("\n")[1]).toStartWith("word ");
  });

  test("yields nothing where the budget cannot hold the accounting", () => {
    expect(trimOutput("some output here", 5)).toBe("");
  });

  test("counts every dropped character, the elision marker's own included", () => {
    const output = `${"line\n".repeat(100)}the failure`;
    const trimmed = trimOutput(output, 60);
    const marker = trimmed.match(/\[(\d+) of (\d+) characters elided\]/);
    if (!marker) throw new Error("no elision marker");
    const kept = trimmed.slice(marker[0].length + 1);
    expect(Number(marker[1]) + kept.length).toBe(output.length);
    expect(Number(marker[2])).toBe(output.length);
  });

  test("reports the width of the elision marker", () => {
    expect(elisionMarker(4, 9)).toBe("[4 of 9 characters elided]");
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
    machine: "Mac Studio",
    time: "2026-09-05 03:00:12 PDT",
    revision: "abc123",
    extraMeta: "",
    cause: "fatal: could not resolve host",
    logPath: "/state/dotfiles/runs/drift-9f8e.log",
    marker: "dotfiles-job a1b2c3d4/drift/9f8e",
    command: "brew bundle",
    outputHeading: "Error Output",
    output: "boom",
  };

  test("opens with the machine, time and revision", () => {
    expect(buildNotes(note)).toStartWith(
      "- **Machine:** Mac Studio\n- **First seen:** 2026-09-05 03:00:12 PDT\n- **Revision:** abc123\n",
    );
  });

  test("names the cause it was filed against and where every run is kept", () => {
    expect(buildNotes(note)).toContain("- **Cause:** fatal: could not resolve host");
    expect(buildNotes(note)).toContain("- **Every run:** /state/dotfiles/runs/drift-9f8e.log");
  });

  // The marker is what the next run finds the to-do by, so its absence would make
  // every repeat file a second to-do.
  test("carries the marker", () => {
    expect(buildNotes(note)).toContain("`dotfiles-job a1b2c3d4/drift/9f8e`");
  });

  test("appends extra metadata to the header only when there is some", () => {
    expect(buildNotes(note)).not.toContain("- **Claude:**");
    expect(buildNotes({ ...note, extraMeta: "- **Claude:** 2.0" })).toContain(
      "- **Revision:** abc123\n- **Claude:** 2.0\n",
    );
  });

  test("fences the reproduction command and names the output section", () => {
    expect(buildNotes(note)).toContain("```sh\nbrew bundle\n```\n\n## Error Output\n```\nboom\n```");
  });

  test("closes the fence on the line after the last log line", () => {
    expect(buildNotes({ ...note, output: "boom\n\n\n" })).toEndWith("boom\n```");
  });

  // The regression: the error is the last line, and it was the part Things cut.
  test("keeps the note within what Things stores and keeps the error that ended the run", () => {
    const big = `${" plugins/some/path.ts | 12 ++++\n".repeat(400)}WARN the actual failure\n`;
    const notes = buildNotes({ ...note, output: big });
    expect(notes.length).toBeLessThanOrEqual(THINGS_NOTES_LIMIT);
    expect(notes).toContain("WARN the actual failure");
  });
});

describe("appendBlock", () => {
  test("heads the block with the run and the time", () => {
    expect(appendBlock(3, "2026-09-11 03:00:04 PDT", "boom", 2000)).toContain(
      "### Run 3 — 2026-09-11 03:00:04 PDT",
    );
  });

  test("fences the run's output", () => {
    expect(appendBlock(2, "monday", "boom", 2000)).toEndWith("```\nboom\n```");
  });

  test("stays inside the room the note has left", () => {
    const block = appendBlock(2, "monday", "x".repeat(5000), 500);
    expect(block.length).toBeLessThanOrEqual(500);
  });

  // Every run is in the log whether or not it fits here, so the note says which
  // of the two happened.
  test("points at the log where the output cannot fit at all", () => {
    const block = appendBlock(2, "monday", "x".repeat(5000), 64);
    expect(block).toContain("in the log");
    expect(block.length).toBeLessThanOrEqual(64);
  });

  // Appending nothing still updates the title, so the run count moves and the
  // run stays in the log.
  test("appends nothing where not even the pointer fits", () => {
    expect(appendBlock(2, "monday", "x".repeat(5000), 20)).toBe("");
  });
});

// Nothing can be appended without the token, and a note that did not say so would
// leave the runs after this one unrecorded and unexplained.
describe("missing auth token", () => {
  test("says so in the note it files", () => {
    writeStub(stub("security"), "exit 1");
    fail("boom");
    expect(filedNotes()).toContain("things-auth-token");
  });

  test("says nothing about it on a machine that has one", () => {
    fail("boom");
    expect(filedNotes()).not.toContain("things-auth-token");
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
    rmSync(stub("osascript"));
    expect(() => notify("Dotfiles Sync", "Updated")).not.toThrow();
    expect(notifications()).toEqual([]);
  });
});
