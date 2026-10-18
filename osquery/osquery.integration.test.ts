import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { must, run } from "#harness";

interface Query {
  query: string;
  interval: number;
  snapshot?: boolean;
  platform?: string;
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const configPath = join(configHome, "osquery", "osquery.conf");
const schedule: Record<string, Query> = JSON.parse(readFileSync(configPath, "utf8")).schedule;

// osquery's platform filter: a comma list of os names, where posix spans the
// unixes and all or any matches everywhere.
const os = process.platform === "win32" ? "windows" : process.platform;
const runsHere = ({ platform = "all" }: Query) =>
  platform
    .split(",")
    .some((p) => p === os || p === "all" || p === "any" || (p === "posix" && os !== "windows"));
const queries = Object.entries(schedule).filter(([, query]) => runsHere(query));

const scratch = () => mkdtempSync(join(tmpdir(), "osquery-"));

// The daemon logs nothing until its scheduler has started (about 13s measured
// on Linux), then runs each query within one interval plus its splay.
const STARTUP_MS = 20_000;
const POLL_MS = 1000;

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    value = read();
  }
  return value;
}

describe("osquery", () => {
  test("symlinks the config into place", () => {
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  });

  test("accepts the config", () => {
    must(["osqueryd", "--config_check", `--config_path=${configPath}`, `--database_path=${scratch()}`]);
  });

  // config_check parses the schedule but never prepares its SQL, so a missing
  // table or column only shows when a query runs.
  for (const [name, { query }] of queries) {
    test(`runs the ${name} query`, () => {
      const flags = ["--json", "--disable_extensions", `--config_path=${configPath}`];
      const r = run(["osqueryd", "-S", ...flags, `--database_path=${scratch()}`, query]);
      expect(r.status).toBe(0);
      expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    });
  }

  // A snapshot logs on every run, even an empty one. A differential query logs
  // only when its rows change, which a quiet CI runner may never do.
  const [first, { interval }] = queries
    .filter(([, query]) => query.snapshot)
    .reduce((a, b) => (b[1].interval < a[1].interval ? b : a));
  const timeoutMs = STARTUP_MS + interval * 2 * 1000;

  test(
    `the daemon logs the ${first} query`,
    async () => {
      const state = scratch();
      const daemon = Bun.spawn(
        [
          "osqueryd",
          `--config_path=${configPath}`,
          `--database_path=${join(state, "db")}`,
          `--pidfile=${join(state, "osqueryd.pid")}`,
          `--logger_path=${state}`,
          "--disable_extensions",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        const logged = await waitFor(() => {
          const log = join(state, "osqueryd.snapshots.log");
          if (!existsSync(log)) return undefined;
          const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
          return lines.map((line) => JSON.parse(line)).find((entry) => entry.name === first);
        }, timeoutMs);
        expect(logged).toBeDefined();
        console.log(JSON.stringify(logged));
      } finally {
        daemon.kill();
        await daemon.exited;
      }
    },
    timeoutMs + STARTUP_MS,
  );
});
