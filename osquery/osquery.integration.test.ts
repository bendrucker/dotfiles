import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { must, run } from "#harness";

interface Query {
  query: string;
  interval: number;
  platform?: string;
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const configPath = join(configHome, "osquery", "osquery.conf");
const snapshots = join(stateHome, "osquery", "logs", "osqueryd.snapshots.log");
const schedule: Record<string, Query> = JSON.parse(readFileSync(configPath, "utf8")).schedule;
const platform = process.platform === "darwin" ? "darwin" : "linux";
const database = () => `--database_path=${mkdtempSync(join(tmpdir(), "osquery-"))}`;

// osquery splays each query's first run across its interval, and the agent may
// still be starting when the test does.
const SAMPLE_INTERVALS = 6;
const POLL_MS = 1000;
const sampleWaitMs = (schedule.pressure?.interval ?? 0) * 1000 * SAMPLE_INTERVALS;

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
    must(["osqueryd", "--config_check", `--config_path=${configPath}`, database()]);
  });

  // config_check parses the schedule but never prepares its SQL, so a missing
  // table or column only shows when a query runs. The session variable tags
  // the shell itself for proc_tags to find.
  for (const [name, { query, platform: only }] of Object.entries(schedule)) {
    test.skipIf(only !== undefined && only !== platform)(`runs the ${name} query`, () => {
      const flags = ["--json", "--disable_extensions", `--config_path=${configPath}`, database()];
      const r = run(["osqueryd", "-S", ...flags, query], {
        env: { CLAUDE_CODE_SESSION_ID: "osquery-integration" },
      });
      expect(r.stderr).not.toContain("Error");
      expect(r.status).toBe(0);
      const rows: unknown[] = JSON.parse(r.stdout);
      expect(rows.length).toBeGreaterThan(0);
      console.log(`${name}:`, JSON.stringify(rows.slice(0, 3)));
    });
  }

  test.skipIf(platform !== "darwin")(
    "the agent bootstrap loaded logs a pressure sample",
    async () => {
      const sample = await waitFor(
        () =>
          existsSync(snapshots)
            ? readFileSync(snapshots, "utf8")
                .split("\n")
                .find((line) => line.includes('"name":"pressure"'))
            : undefined,
        sampleWaitMs,
      );
      expect(sample).toBeDefined();
      console.log(sample);
    },
    sampleWaitMs * 2,
  );
});
