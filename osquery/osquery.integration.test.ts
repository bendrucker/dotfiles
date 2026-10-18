import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must, repoRoot, run } from "#harness";

const configPath = join(repoRoot, "osquery", "osquery.conf");
const schedule: Record<string, { query: string; platform?: string }> = JSON.parse(
  readFileSync(configPath, "utf8"),
).schedule;
const platform = process.platform === "darwin" ? "darwin" : "linux";
const database = () => `--database_path=${mkdtempSync(join(tmpdir(), "osquery-"))}`;

describe("osquery", () => {
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

  // The LaunchAgent bootstrap loaded logs a pressure sample every 10 seconds.
  test.skipIf(platform !== "darwin")(
    "the agent logs a pressure sample",
    async () => {
      const log = join(process.env.HOME ?? "", ".local/state/osquery/logs/osqueryd.snapshots.log");
      const sample = () =>
        existsSync(log)
          ? readFileSync(log, "utf8")
              .split("\n")
              .find((line) => line.includes('"name":"pressure"'))
          : undefined;
      for (let waited = 0; waited < 60_000 && sample() === undefined; waited += 2000) {
        await Bun.sleep(2000);
      }
      expect(sample()).toBeDefined();
      console.log(sample());
    },
    70_000,
  );
});
