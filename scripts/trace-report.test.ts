import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "trace-report");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("trace-report-cli");
  const t0 = 1791479525n * 1_000_000_000n;
  const at = (seconds: number) => t0 + BigInt(seconds) * 1_000_000_000n;
  box.write(
    "trace/events.tsv",
    [`B\t${at(0)}\t1\t0\tbootstrap`, `B\t${at(5)}\t1\t0\tbrew bundle`, `E\t${at(50)}\t1\t0\t`, `X\t${at(60)}\t1\t0`, ""].join("\n"),
  );
});

afterEach(() => {
  box.remove();
});

describe("trace-report", () => {
  test("prints the summary when no file is named", () => {
    const r = run(["bun", script, box.path("trace"), "--top", "1"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### Bootstrap trace: 1m 0s, succeeded, 2 spans");
    expect(r.stdout).toContain("| brew bundle | bootstrap | 45.0s | 45.0s |");
  });

  test("writes the summary and the OTLP export to the files named", () => {
    const r = run(["bun", script, box.path("trace"), "--summary", box.path("summary.md"), "--otlp", box.path("otlp.json")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(box.read("summary.md")).toContain("```mermaid");
    const otlp: unknown = JSON.parse(box.read("otlp.json"));
    expect(otlp).toMatchObject({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "bootstrap" }, { name: "brew bundle" }] }] }] });
  });

  test("fails naming the directory when it holds no trace", () => {
    const r = run(["bun", script, box.mkdir("empty")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no events.tsv");
  });

  test.each<[string, string[]]>([
    ["no directory", []],
    ["a negative --top", ["dir", "--top", "-1"]],
    ["a non-numeric --min", ["dir", "--min", "soon"]],
  ])("rejects %s", (_, args) => {
    expect(run(["bun", script, ...args]).status).toBe(2);
  });
});
