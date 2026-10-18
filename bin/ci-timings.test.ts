import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, type Sandbox } from "#harness";
import { type ApiJob, type ApiRun, flatten, loadSql, reportSql, since } from "./ci-timings";

const SCRIPT = join(import.meta.dir, "ci-timings");

const RUN: ApiRun = { id: 7, event: "pull_request", head_branch: "feature", status: "completed" };

const JOB: ApiJob = {
  id: 70,
  run_id: 7,
  run_attempt: 1,
  name: "bootstrap (macos)",
  conclusion: "success",
  labels: ["macos-15"],
  created_at: "2026-10-16T06:06:06Z",
  started_at: "2026-10-16T06:07:33Z",
  completed_at: "2026-10-16T06:13:51Z",
  steps: [
    {
      name: "Restore Homebrew packages",
      number: 10,
      conclusion: "success",
      started_at: "2026-10-16T06:08:31Z",
      completed_at: "2026-10-16T06:12:12Z",
    },
  ],
};

describe("flatten", () => {
  test("gives one row per job and one per step, both keyed by job id", () => {
    const { jobRows, stepRows } = flatten("o/r", RUN, [JOB]);
    expect(jobRows).toEqual([
      {
        repo: "o/r",
        run_id: 7,
        event: "pull_request",
        branch: "feature",
        attempt: 1,
        job_id: 70,
        job: "bootstrap (macos)",
        runner: "macos-15",
        conclusion: "success",
        created_at: JOB.created_at,
        started_at: JOB.started_at,
        completed_at: JOB.completed_at,
      },
    ]);
    expect(stepRows).toEqual([
      {
        repo: "o/r",
        job_id: 70,
        job: "bootstrap (macos)",
        number: 10,
        step: "Restore Homebrew packages",
        conclusion: "success",
        started_at: "2026-10-16T06:08:31Z",
        completed_at: "2026-10-16T06:12:12Z",
      },
    ]);
  });

  test("reads a job without steps as having none", () => {
    expect(flatten("o/r", RUN, [{ ...JOB, steps: undefined }]).stepRows).toEqual([]);
  });
});

test("since names the UTC date the window opens on", () => {
  expect(since(14, new Date("2026-10-18T02:00:00Z"))).toBe("2026-10-04");
});

test("loadSql replaces only the fetched repos", () => {
  const sql = loadSql(["o/r", "o/it's"], "/t/jobs.ndjson", "/t/steps.ndjson");
  expect(sql).toContain("delete from jobs where repo in ('o/r', 'o/it''s');");
  expect(sql).toContain("read_json('/t/steps.ndjson'");
});

test("reportSql windows both queries on the job's creation", () => {
  expect(reportSql(3).match(/now\(\) - interval 3 day/g)).toHaveLength(2);
});

describe("ci-timings", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("ci-timings");
    // Answers the runs listing and the jobs listing the way --jq leaves them:
    // one JSON value per line.
    box.stub(
      "gh",
      [
        'case "$3" in',
        `  */jobs*) echo '${JSON.stringify(JOB)}' ;;`,
        `  *) echo '${JSON.stringify(RUN)}'; echo '${JSON.stringify({ ...RUN, id: 8, status: "in_progress" })}' ;;`,
        "esac",
      ].join("\n"),
    );
    // Keeps the files the SQL loads, which fetch removes once duckdb returns.
    box.stub(
      "duckdb",
      `eval "sql=\\\${$#}"; printf '%s' "$sql" > "${box.path("sql")}"\n` +
        `for f in $(printf '%s' "$sql" | grep -o "/[^']*ndjson"); do cat "$f" >> "${box.path("rows")}"; done`,
    );
  });

  afterEach(() => box.remove());

  test("fetch loads completed runs' jobs and steps into the database", () => {
    const db = box.path("state", "ci.duckdb");
    const result = run([SCRIPT, "fetch", "--db", db, "o/r"], { path: [box.bin] });
    expect(result.stderr).toContain("o/r: 1 runs");
    expect(result.status).toBe(0);
    const rows = box.read("rows").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.job_id)).toEqual([70, 70]);
    expect(box.read("sql")).toContain("delete from jobs where repo in ('o/r');");
  });

  test("fetch without a repo prints usage", () => {
    const result = run([SCRIPT, "fetch"], { path: [box.bin] });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: ci-timings");
  });

  test("rejects a window that is not a whole number of days", () => {
    expect(run([SCRIPT, "report", "--days", "1.5"], { path: [box.bin] }).status).toBe(2);
  });
});
