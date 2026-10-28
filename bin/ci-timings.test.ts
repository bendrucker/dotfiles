import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeIo, run, sandbox, type Sandbox } from "#harness";
import { main } from "./ci-timings";

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

describe("main", () => {
  const row = '{"id":7,"event":"push","name":"job","steps":[]}\n';
  const db = join(tmpdir(), "ci-timings-fake", "ci.duckdb");

  test("loads every job through duckdb with the repo and run event", async () => {
    const io = fakeIo({ answers: [{ argv: ["gh"], stdout: row }, { argv: ["duckdb"] }] });

    expect(await main(io, ["fetch", "--db", db, "o/r"])).toBe(0);

    const stdin = io.calls.find((call) => call.argv[0] === "duckdb")?.options?.stdin;
    expect(typeof stdin === "object" ? JSON.parse(stdin.input) : stdin).toEqual({
      id: 7,
      event: "push",
      name: "job",
      steps: [],
      repo: "o/r",
    });
    expect(io.captured()).toBe("o/r: 1 runs\n");
  });

  test("names the gh call that failed", async () => {
    const io = fakeIo({ answers: [{ argv: ["gh"], status: 1 }] });

    await expect(main(io, ["fetch", "--db", db, "o/r"])).rejects.toThrow("gh api repos/o/r/actions/runs");
    expect(io.calls.some((call) => call.argv[0] === "duckdb")).toBe(false);
  });
});
