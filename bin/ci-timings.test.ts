import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { run, sandbox, type Sandbox } from "#harness";

const SCRIPT = join(import.meta.dir, "ci-timings");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("ci-timings");
  box.stub(
    "gh",
    [
      'case "$3" in',
      `  */jobs*) echo '{"id":70,"name":"bootstrap (macos)","steps":[]}' ;;`,
      `  *) echo '{"id":7,"event":"pull_request"}' ;;`,
      "esac",
    ].join("\n"),
  );
  box.stub("duckdb", `cat > "${box.path("stdin")}"`);
});

afterEach(() => box.remove());

test("fetch hands duckdb each job tagged with its repo and run event", () => {
  const result = run([SCRIPT, "fetch", "--db", box.path("ci.duckdb"), "o/r"], { path: [box.bin] });
  expect(result.status).toBe(0);
  expect(JSON.parse(box.read("stdin"))).toEqual({
    id: 70,
    name: "bootstrap (macos)",
    steps: [],
    repo: "o/r",
    event: "pull_request",
  });
});

test.each([[["fetch"]], [["fetch", "--days", "1.5", "o/r"]], [["status"]]])("%p prints usage", (args) => {
  const result = run([SCRIPT, ...args], { path: [box.bin] });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Usage: ci-timings");
});
