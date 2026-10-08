import { describe, expect, test } from "bun:test";
import type { Span } from "#trace/span";
import { formatDuration, gantt, indentedTree, renderSummary, topTable } from "#trace/summary";
import { buildTree } from "#trace/tree";

const S = 1e6;
const T0 = 1791479525 * S;

function makeSpan(name: string, start: number, end: number, parent?: Span, overrides: Partial<Span> = {}): Span {
  return { name, start: T0 + start * S, end: T0 + end * S, error: false, source: "shell", parent, ...overrides };
}

function fixture() {
  const root = makeSpan("bootstrap", 0, 400, undefined, { error: true });
  const homebrew = makeSpan("homebrew.sh", 1, 5, root);
  const dotf = makeSpan("dotf", 6, 400, root, { error: true });
  const install = makeSpan("install", 7, 400, dotf, { error: true });
  const bundle = makeSpan("brew bundle", 8, 280, install);
  const pour = makeSpan("pour gum: v0.17", 100, 130, bundle, { source: "homebrew" });
  const topics = makeSpan("install-topics", 300, 400, install, { error: true });
  const herdr = makeSpan("topic herdr", 300, 350, topics, { error: true });
  const quick = makeSpan("topic git", 350, 350.2, topics);
  return buildTree([root, homebrew, dotf, install, bundle, pour, topics, herdr, quick]);
}

describe("formatDuration", () => {
  test.each<[number, string]>([
    [0.42, "0.42s"],
    [12.34, "12.3s"],
    [272, "4m 32s"],
    [299.6, "5m 0s"],
  ])("%p seconds reads %p", (seconds, expected) => {
    expect(formatDuration(seconds * S)).toBe(expected);
  });
});

describe("gantt", () => {
  test("renders the top levels plus long spans, one section per top-level step", () => {
    expect(gantt(fixture())).toMatchInlineSnapshot(`
      "\`\`\`mermaid
      gantt
          dateFormat x
          axisFormat %M:%S
          todayMarker off
          section bootstrap
          bootstrap 6m 40s :crit, s0, 0, 400000
          section homebrew.sh
          homebrew.sh 4.00s :s1, 1000, 5000
          section dotf
          dotf 6m 34s :crit, s2, 6000, 400000
          install 6m 33s :crit, s3, 7000, 400000
          brew bundle 4m 32s :s4, 8000, 280000
          pour gum v0.17 30.0s :s5, 100000, 130000
          install-topics 1m 40s :crit, s6, 300000, 400000
          topic herdr 50.0s :crit, s7, 300000, 350000
      \`\`\`"
    `);
  });

  test("every task line is one mermaid can read", () => {
    const tasks = gantt(fixture())
      .split("\n")
      .filter((line) => line.startsWith("    ") && !/^\s+(section|dateFormat|axisFormat|todayMarker) /.test(line));
    for (const line of tasks) expect(line).toMatch(/^ {4}[^:;#]+ :(crit, )?s\d+, \d+, \d+$/);
  });

  test("caps the bars at 40, keeping the longest", () => {
    const root = makeSpan("root", 0, 1000);
    const steps = Array.from({ length: 60 }, (_, i) => makeSpan(`step ${i}`, i * 10, i * 10 + 1 + i / 10, root));
    const bars = gantt(buildTree([root, ...steps])).split("\n").filter((line) => / :(crit, )?s\d+, /.test(line));
    expect(bars).toHaveLength(40);
    expect(bars.join("\n")).toContain("step 59");
    expect(bars.join("\n")).not.toContain("step 1 ");
  });
});

describe("topTable", () => {
  test("ranks by self time", () => {
    expect(topTable(fixture(), 4)).toMatchInlineSnapshot(`
      "| span | parent | total | self |
      | --- | --- | ---: | ---: |
      | brew bundle | install | 4m 32s | 4m 2s |
      | topic herdr | install-topics | 50.0s | 50.0s |
      | install-topics | install | 1m 40s | 49.8s |
      | pour gum: v0.17 | brew bundle | 30.0s | 30.0s |"
    `);
  });
});

describe("indentedTree", () => {
  test("hides spans under the minimum and counts them", () => {
    const { text, hidden } = indentedTree(fixture(), 1);
    expect(hidden).toBe(1);
    expect(text).toMatchInlineSnapshot(`
      "bootstrap  6m 40s  ✗
        homebrew.sh  4.00s
        dotf  6m 34s  ✗
          install  6m 33s  ✗
            brew bundle  4m 32s
              pour gum: v0.17  30.0s
            install-topics  1m 40s  ✗
              topic herdr  50.0s  ✗"
    `);
  });
});

describe("renderSummary", () => {
  test("leads with total and status and names the artifact", () => {
    const summary = renderSummary(fixture(), { top: 3, min: 1 });
    expect(summary.split("\n")[0]).toBe("### Bootstrap trace: 6m 40s, failed, 9 spans");
    expect(summary).toContain("```mermaid\ngantt");
    expect(summary).toContain("<details>");
    expect(summary).toContain("`bootstrap-trace` artifact");
  });
});
