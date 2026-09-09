import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finding, findings, isRealDate, parseMarker, report, today, unmarked } from "./lint-expired";

const SCRIPT = join(import.meta.dir, "lint-expired");
const TODAY = "2026-07-28";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lint-expired-"));
  git(["init", "--quiet", sandbox]);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function git(args: string[]): void {
  const run = Bun.spawnSync({ cmd: ["git", ...args], env: process.env, stdin: "ignore" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

// git grep only sees tracked files, so a fixture has to be staged.
function fixture(...lines: string[]): void {
  writeFileSync(join(sandbox, "migration.sh"), `${lines.join("\n")}\n`);
  git(["-C", sandbox, "add", "-A"]);
}

// A migration file under the directory the runner reads, where the marker is
// required rather than optional.
function migrationFixture(name: string, ...lines: string[]): void {
  mkdirSync(join(sandbox, "migrations"), { recursive: true });
  writeFileSync(join(sandbox, "migrations", name), `${lines.join("\n")}\n`);
  git(["-C", sandbox, "add", "-A"]);
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

// Run through bun by path rather than by shebang, so the case does not depend
// on where bun sits on this machine's PATH.
function run(args: string[] = [sandbox], extra: Record<string, string> = {}): Outcome {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, LINT_EXPIRED_TODAY: TODAY, ...extra },
    stdin: "ignore",
  });
  return {
    status: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

describe("parseMarker", () => {
  test.each<{ name: string; text: string; date: string; reason: string }>([
    {
      name: "reads the date and the reason after it",
      text: "# EXPIRES: 2026-10-26 every machine has the upgrade job",
      date: "2026-10-26",
      reason: "every machine has the upgrade job",
    },
    {
      name: "keeps a reason carrying a percent sign or a colon",
      text: "# EXPIRES: 2020-01-01 100% of machines: done",
      date: "2020-01-01",
      reason: "100% of machines: done",
    },
    {
      name: "a date with no reason",
      text: "# EXPIRES: 2020-01-01",
      date: "2020-01-01",
      reason: "",
    },
    { name: "no date at all", text: "# EXPIRES: soon enough", date: "", reason: "" },
    {
      name: "a date that is not the shape the marker calls for",
      text: "# EXPIRES: 26-10-1 soon",
      date: "",
      reason: "",
    },
  ])("$name", ({ text, date, reason }) => {
    expect(parseMarker(text)).toEqual({ date, reason });
  });
});

describe("isRealDate", () => {
  test.each<{ name: string; date: string; real: boolean }>([
    { name: "an ordinary date", date: "2026-07-28", real: true },
    { name: "the last day of a 30-day month", date: "2099-04-30", real: true },
    { name: "the 31st of a 30-day month", date: "2099-04-31", real: false },
    { name: "February 29 in a leap year", date: "2028-02-29", real: true },
    { name: "February 29 in a common year", date: "2026-02-29", real: false },
    { name: "February 29 in a century that is not a leap year", date: "2100-02-29", real: false },
    { name: "February 29 in a leap century", date: "2000-02-29", real: true },
    { name: "a day that month never has", date: "2026-02-31", real: false },
    { name: "an out-of-range month", date: "2026-13-01", real: false },
    { name: "a zero month", date: "2026-00-01", real: false },
    { name: "a zero day", date: "2026-01-00", real: false },
    { name: "nothing at all", date: "", real: false },
  ])("$name", ({ date, real }) => {
    expect(isRealDate(date)).toBe(real);
  });
});

describe("findings", () => {
  test("says nothing about a date still in the future", () => {
    expect(findings(["a.sh:1:# EXPIRES: 2099-12-31 not yet"], TODAY)).toEqual([]);
  });

  test("treats the expiry date itself as not yet due", () => {
    expect(findings([`a.sh:1:# EXPIRES: ${TODAY} expires today`], TODAY)).toEqual([]);
  });

  test("reports the location, date, and reason once past the date", () => {
    expect(findings(["a.sh:12:# EXPIRES: 2026-07-27 the upgrade job landed"], TODAY)).toEqual([
      {
        kind: "expired",
        location: "a.sh:12",
        date: "2026-07-27",
        reason: "the upgrade job landed",
      },
    ]);
  });

  // A date that can never fire is worse than no marker, because it reads as
  // tracked when it is not.
  test("reports a marker whose date cannot be read", () => {
    expect(findings(["a.sh:1:# EXPIRES: soon enough"], TODAY)).toEqual([
      { kind: "malformed", location: "a.sh:1", date: "", reason: "" },
    ]);
  });

  test("passes over the files that document the marker", () => {
    const matches = [
      "scripts/lint-expired:11:#   EXPIRES: 2020-01-01 an example",
      "scripts/lint-expired.test.ts:1:# EXPIRES: 2020-01-01 a fixture",
      "CLAUDE.md:270:Give it an `EXPIRES:` marker.",
    ];
    expect(findings(matches, TODAY)).toEqual([]);
  });
});

describe("unmarked", () => {
  const migration = "migrations/202601010001-remove-thing.ts";

  test("reports a migration the grep never matched", () => {
    expect(unmarked([migration], ["scripts/install:34:# EXPIRES: 2099-01-01 something else"])).toEqual([
      { kind: "unmarked", location: migration, date: "", reason: "" },
    ]);
  });

  test("says nothing about a migration that carries one", () => {
    expect(unmarked([migration], [`${migration}:12:// EXPIRES: 2099-01-01 done`])).toEqual([]);
  });

  test("passes over the files in the directory that are not migrations", () => {
    const listed = ["migrations/202601010001-remove-thing.test.ts", "migrations/README.md"];
    expect(unmarked(listed, [])).toEqual([]);
  });
});

describe("report", () => {
  const expired = (date: string, reason: string): Finding => ({
    kind: "expired",
    location: "a.sh:1",
    date,
    reason,
  });

  test("says nothing when nothing was found", () => {
    expect(report([])).toEqual([]);
  });

  test("counts one expired marker in the singular", () => {
    expect(report([expired("2020-01-01", "done")])).toMatchInlineSnapshot(`
      [
        "ERROR: 1 migration is past the expiry date.",
        "  a.sh:1  EXPIRES: 2020-01-01",
        "    done",
        "  Remove it, or push the date out because the reason still holds.",
      ]
    `);
  });

  test("counts more than one in the plural", () => {
    const lines = report([expired("2020-01-01", "first"), expired("2021-01-01", "second")]);
    expect(lines[0]).toBe("ERROR: 2 migrations are past the expiry date.");
  });

  test("leaves the reason line off a marker that carries none", () => {
    expect(report([expired("2020-01-01", "")])).not.toContain("    ");
  });

  test("lists a migration with no marker under its own heading", () => {
    const found: Finding[] = [
      { kind: "unmarked", location: "migrations/202601010001-a.ts", date: "", reason: "" },
    ];
    expect(report(found)).toEqual([
      "ERROR: migration with no EXPIRES: marker saying when to delete it:",
      "  migrations/202601010001-a.ts",
    ]);
  });

  test("lists the malformed markers under their own heading", () => {
    const found: Finding[] = [{ kind: "malformed", location: "a.sh:1", date: "", reason: "" }];
    expect(report(found)).toEqual([
      "ERROR: malformed EXPIRES: marker (expected EXPIRES: YYYY-MM-DD reason):",
      "  a.sh:1",
    ]);
  });
});

describe("today", () => {
  test("takes the override when one is set", () => {
    process.env.LINT_EXPIRED_TODAY = "2026-07-28";
    expect(today()).toBe("2026-07-28");
    delete process.env.LINT_EXPIRED_TODAY;
  });

  // A UTC reading would expire a marker up to a day early west of Greenwich.
  test("reads the machine's own date when no override is set", () => {
    delete process.env.LINT_EXPIRED_TODAY;
    const now = new Date();
    const pad = (part: number): string => String(part).padStart(2, "0");
    expect(today()).toBe(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  });
});

describe("the executable", () => {
  test("prints the usage on --help", () => {
    const outcome = run(["--help"]);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toStartWith("usage: lint-expired [dotfiles-root]");
  });

  test("passes when the date is still in the future", () => {
    fixture("# EXPIRES: 2099-12-31 the slow machine has not synced yet");

    const outcome = run();
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe("");
  });

  test("passes when nothing is marked at all", () => {
    fixture("echo no markers here");
    expect(run().status).toBe(0);
  });

  test("reports the location, date, and reason once past the date", () => {
    fixture("# EXPIRES: 2026-07-27 every machine has the upgrade job");

    const outcome = run();
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("1 migration is past the expiry date");
    expect(outcome.stderr).toContain("migration.sh:1");
    expect(outcome.stderr).toContain("EXPIRES: 2026-07-27");
    expect(outcome.stderr).toContain("every machine has the upgrade job");
  });

  test("counts more than one expired marker", () => {
    fixture("# EXPIRES: 2020-01-01 first", "echo x", "# EXPIRES: 2021-01-01 second");

    const outcome = run();
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("2 migrations are past the expiry date");
  });

  test("rejects a marker with no parseable date", () => {
    fixture("# EXPIRES: soon enough");

    const outcome = run();
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("malformed");
    expect(outcome.stderr).toContain("migration.sh:1");
  });

  test("ignores a marker in an untracked file", () => {
    fixture("echo tracked");
    writeFileSync(join(sandbox, "untracked.sh"), "# EXPIRES: 2020-01-01 untracked\n");

    expect(run().status).toBe(0);
  });

  test("fails on a migration carrying no marker", () => {
    fixture("echo tracked");
    migrationFixture("202601010001-remove-thing.ts", "export function up() {}");

    const outcome = run();
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("no EXPIRES: marker");
    expect(outcome.stderr).toContain("migrations/202601010001-remove-thing.ts");
  });

  test("passes on a migration carrying one that is still in the future", () => {
    fixture("echo tracked");
    migrationFixture(
      "202601010001-remove-thing.ts",
      "// EXPIRES: 2099-12-31 every machine has run it",
      "export function up() {}",
    );

    expect(run().status).toBe(0);
  });

  // A lint that reports nothing because it never looked is worse than one that
  // fails.
  test("fails when git cannot search the tree", () => {
    const bare = join(sandbox, "outside");
    mkdirSync(bare);
    rmSync(join(sandbox, ".git"), { recursive: true });

    const outcome = run([bare]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("git grep could not search");
  });
});
