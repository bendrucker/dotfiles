import { describe, expect, test } from "bun:test";
import { render } from "./board";
import type { Row } from "./rows";

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    workspaceId: "w1",
    label: "topic",
    path: "/p",
    repoRoot: "/r",
    repoName: "repo",
    branch: "topic",
    forge: "github",
    pr: { number: 7, ref: "repo#7" },
    step: "go",
    reason: "CI failing",
    flags: [],
    ignored: [],
    ...overrides,
  };
}

describe("render", () => {
  test("shows actionable rows and counts the rest", () => {
    const local = [
      makeRow(),
      makeRow({ workspaceId: "w4", label: "plans", pr: undefined, step: "review", reason: "plan", detail: "approve the wt plan" }),
      makeRow({ workspaceId: "w2", label: "landed", pr: undefined, step: "prune", reason: "merged", flags: ["ignored:2"] }),
      makeRow({ workspaceId: "w3", label: "busy", step: "collapsed", reason: "working" }),
    ];
    const remote = [makeRow({ workspaceId: "w9", label: "far", machine: "work" })];
    expect(render(local, remote, true).map(Bun.stripANSI)).toMatchInlineSnapshot(`
      [
        "	cleanup · 3 need you · 1 safe to finish · 1 collapsed · with work",
        "	enter go · p prune · x close · w wake · r refresh · m work · q quit",
        "local:w1	→ go      topic     repo#7  CI failing",
        "local:w4	→ review  plans             plan · approve the wt plan",
        "local:w2	→ prune   landed            merged · ignored:2",
        "work:w9	→ go      work:far  repo#7  CI failing",
      ]
    `);
  });

  test.each([
    { name: "herdr", local: undefined, remote: [], shown: "herdr unreachable" },
    { name: "the machine", local: [], remote: undefined, shown: "work unreachable" },
  ])("says $name is unreachable rather than showing nothing", ({ local, remote, shown }) => {
    expect(Bun.stripANSI(render(local, remote, true)[0] ?? "")).toContain(shown);
  });

  test.each<{ name: string; row: Partial<Row>; colored: string }>([
    { name: "a failing go row", row: {}, colored: "\x1b[1;31m→ go\x1b[0m" },
    { name: "a review row", row: { step: "review", reason: "code" }, colored: "\x1b[1;36m→ review\x1b[0m" },
    { name: "requested changes", row: { step: "wake", reason: "changes requested" }, colored: "\x1b[33mchanges requested\x1b[0m" },
    { name: "a merged prune row", row: { step: "prune", reason: "merged" }, colored: "\x1b[35mmerged\x1b[0m" },
    { name: "a live flag", row: { step: "prune", reason: "merged", flags: ["live"] }, colored: "\x1b[31mlive\x1b[0m" },
    { name: "the pull request", row: {}, colored: "\x1b[34mrepo#7\x1b[0m" },
  ])("colors $name", ({ row, colored }) => {
    expect(render([makeRow(row)], [], false)[2]).toContain(colored);
  });
});
