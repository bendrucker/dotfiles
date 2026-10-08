import { describe, expect, test } from "bun:test";
import { age, render } from "./board";
import type { Row } from "./rows";

const NOW = Date.parse("2026-10-07T20:00:00Z");

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    workspaceId: "w1",
    label: "topic",
    path: "/p",
    repoRoot: "/r",
    repoName: "repo",
    branch: "topic",
    forge: "github",
    pr: { number: 7, state: "OPEN", ref: "repo#7" },
    step: "go",
    reason: "CI failing",
    flags: [],
    ignored: [],
    fetchedAt: "2026-10-07T19:58:00Z",
    ...overrides,
  };
}

test.each<[number, string]>([
  [5, "5s ago"],
  [180, "3m ago"],
  [7200, "2h ago"],
  [172800, "2d ago"],
])("%d seconds reads as %s", (secs, expected) => {
  expect(age(new Date(NOW - secs * 1000).toISOString(), NOW)).toBe(expected);
});

describe("render", () => {
  test("shows actionable rows, counts the rest, and says how fresh each source is", () => {
    const local = [
      makeRow(),
      makeRow({ workspaceId: "w2", label: "landed", pr: { number: 3, state: "MERGED", ref: "repo#3" }, step: "prune", reason: "merged", flags: ["ignored:2"] }),
      makeRow({ workspaceId: "w3", label: "busy", step: "collapsed", reason: "working" }),
    ];
    const remote = [makeRow({ workspaceId: "w9", label: "far", machine: "work", fetchedAt: "2026-10-07T19:00:00Z" })];
    expect(render(local, remote, true, NOW)).toMatchInlineSnapshot(`
      [
        "cleanup · 2 need you · 1 safe to finish · 1 collapsed",
        "forge 2m ago · herdr live · work 1h ago   enter go · p prune · x close · w wake · r refresh · m work · q quit",
        "local:w1	topic     repo#7  CI failing          → go",
        "local:w2	landed    repo#3  merged · ignored:2  → prune",
        "work:w9	work:far  repo#7  CI failing          → go",
      ]
    `);
  });

  test("says the machine is unreachable rather than showing nothing", () => {
    expect(render([], undefined, true, NOW)[1]).toStartWith("forge never · herdr live · work unreachable");
  });
});
