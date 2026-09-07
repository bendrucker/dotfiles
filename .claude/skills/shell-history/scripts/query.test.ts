import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { must, quote, run, sandbox, type Sandbox } from "#harness";

const QUERY = join(import.meta.dir, "query.sh");

let box: Sandbox;
let dbPath: string;

// Build a small sqlite history db (atuin's schema) and point the runner at it
// via ATUIN_HISTORY_DB, the same override seam the runner resolves at runtime.
// Timestamps are nanoseconds, matching atuin. One "old" row sits ~400 days back
// to exercise the --recent cutoff. One row is soft-deleted (deleted_at set) to
// confirm it is filtered out.
beforeEach(() => {
  box = sandbox("shell-history-query");
  dbPath = box.path("history.db");

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const now = nowSeconds * 1_000_000_000n;
  const old = (nowSeconds - 400n * 86400n) * 1_000_000_000n;

  // Piped rather than fed by here-doc: bash 3.2 stages a here-doc through a
  // temp file in the cwd or /var/tmp, so a read-only cwd breaks an otherwise
  // fine run.
  const sql = [
    "INSTALL sqlite; LOAD sqlite;",
    `ATTACH '${dbPath}' AS fx (TYPE sqlite);`,
    "CREATE TABLE fx.history (",
    "  id VARCHAR, timestamp BIGINT, duration BIGINT, exit BIGINT,",
    "  command VARCHAR, cwd VARCHAR, session VARCHAR, hostname VARCHAR,",
    "  deleted_at BIGINT, author VARCHAR, intent VARCHAR",
    ");",
    `INSERT INTO fx.history (timestamp, command) SELECT ${now}, 'git push' FROM range(12);`,
    `INSERT INTO fx.history (timestamp, command) SELECT ${now}, 'docker build -t app .' FROM range(3);`,
    "INSERT INTO fx.history (timestamp, command) VALUES",
    `  (${now}, 'npm test && npm run build'),`,
    `  (${now}, 'cat foo | grep bar'),`,
    `  (${old}, 'svn commit -m old');`,
    `INSERT INTO fx.history (timestamp, command, deleted_at) VALUES (${now}, 'secret token abc', ${now});`,
  ].join("\n");

  must(["bash", "-c", `printf '%s\\n' ${quote(sql)} | duckdb`]);
});

afterEach(() => {
  box.remove();
});

// Any .duckdb files under the fixture dir after a run: proof the runner
// persisted state. In-memory runs leave none.
function duckdbArtifacts(): string {
  return run(["find", box.dir, "-name", "*.duckdb"]).stdout.trim();
}

// lstat rather than existsSync, so a dangling symlink still counts as existing
// rather than reading as absent.
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function runQuery(args: string[], env: Record<string, string> = { ATUIN_HISTORY_DB: dbPath }) {
  return run([QUERY, ...args], { env });
}

describe("query.sh", () => {
  test("reports the top command by frequency", () => {
    const r = runQuery(["command-frequency"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("git");
  });

  test("surfaces frequent two-word prefixes as alias candidates", () => {
    const r = runQuery(["alias-candidates", "--recent", "6m"]);
    expect(r.stdout).toContain("git push");
  });

  test("finds && chains in sequences", () => {
    const r = runQuery(["sequences", "--recent", "6m"]);
    expect(r.stdout).toContain("&&");
  });

  test("finds | pipes in sequences", () => {
    const r = runQuery(["sequences", "--recent", "6m"]);
    expect(r.stdout).toContain("|");
  });

  test("excludes entries older than the --recent window", () => {
    const r = runQuery(["command-frequency", "--recent", "6m"]);
    expect(r.stdout).not.toContain("svn");
  });

  test("includes old entries in all-time frequency", () => {
    const r = runQuery(["command-frequency"]);
    expect(r.stdout).toContain("svn");
  });

  test("excludes soft-deleted rows", () => {
    const r = runQuery(["command-frequency"]);
    expect(r.stdout).not.toContain("secret");
  });

  test("writes no .duckdb file (in-memory only)", () => {
    const r = runQuery(["command-frequency"]);
    expect(r.status).toBe(0);
    expect(pathExists(`${dbPath}.duckdb`)).toBe(false);
    expect(duckdbArtifacts()).toBe("");
  });

  test("exits non-zero with a clear message when the db is missing", () => {
    const r = runQuery(["date-range"], { ATUIN_HISTORY_DB: "/nonexistent/history.db" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not found");
  });

  test("rejects an invalid --recent duration", () => {
    const r = runQuery(["command-frequency", "--recent", "6x"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Invalid duration");
  });

  test("reports available queries for an unknown query name", () => {
    const r = runQuery(["bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Unknown query");
  });
});
