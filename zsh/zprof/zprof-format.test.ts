import { describe, expect, test } from "bun:test";
import {
  bar,
  parse,
  renderMarkdown,
  renderTerminal,
  stripControl,
} from "./zprof-format.ts";

const fixture = await Bun.file(new URL("./fixture.txt", import.meta.url)).text();

describe("stripControl", () => {
  test("removes OSC shell-integration codes and their BEL terminator", () => {
    const cleaned = stripControl(fixture);
    expect(cleaned).not.toContain("1337");
    expect(cleaned).not.toContain("\x1b");
    expect(cleaned).not.toContain("\x07");
  });

  test("removes CSI SGR color codes", () => {
    expect(stripControl("\x1b[1;32mgreen\x1b[0m")).toBe("green");
  });

  test("removes non-color CSI (bracketed paste, cursor query)", () => {
    expect(stripControl("\x1b[?2004ha\x1b[?2004l\x1b[6nb")).toBe("ab");
  });
});

describe("parse", () => {
  const profile = parse(fixture);

  test("captures every flat-profile row", () => {
    expect(profile.rows).toHaveLength(17);
  });

  test("parses numeric fields for the top row", () => {
    const compinit = profile.rows.find((r) => r.name === "compinit")!;
    expect(compinit).toMatchObject({
      rank: 1,
      calls: 1,
      totalMs: 12.21,
      selfMs: 12.21,
      selfPct: 33.36,
    });
  });

  test("keeps function names with spaces and brackets intact", () => {
    const anon = profile.rows.find((r) => r.name.startsWith("(anon)"))!;
    expect(anon.name).toBe(
      "(anon) [/usr/share/zsh/5.9/functions/add-zle-hook-widget:28]",
    );
  });

  test("does not treat call-graph entries or zpty warnings as rows", () => {
    const names = profile.rows.map((r) => r.name);
    expect(names).not.toContain("");
    expect(names.every((n) => !n.includes("zpty"))).toBe(true);
    // set_prompt appears once in the flat table and again in the call graph.
    expect(names.filter((n) => n === "set_prompt")).toHaveLength(1);
  });

  test("keeps the call graph as escape-free drill-down text", () => {
    expect(profile.callGraph).toContain("set_prompt");
    expect(profile.callGraph).not.toContain("\x1b");
    expect(profile.callGraph).not.toContain("1337");
  });

  test("returns no rows for input without a flat profile", () => {
    const empty = parse("just some noise\nno table here\n");
    expect(empty.rows).toHaveLength(0);
    expect(empty.callGraph).toBe("");
  });
});

describe("bar", () => {
  test("fills fully at the max and scales down below it", () => {
    expect(bar(33.36, 33.36)).toBe("█".repeat(10));
    const half = bar(16.51, 33.36);
    expect(half.startsWith("█")).toBe(true);
    expect(half).toContain("░");
    expect([...half].filter((c) => c === "█").length).toBeLessThan(10);
  });

  test("empties fully at zero self percent", () => {
    expect(bar(0, 33.36)).toBe("░".repeat(10));
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(parse(fixture));

  test("nests under an h3 and emits the ranked table header", () => {
    expect(md).toContain("### Startup profile");
    expect(md).toContain("| # | Function | Calls | Self (ms) | Self % | Total (ms) |");
  });

  test("sorts rows by self time descending", () => {
    const firstRow = md
      .split("\n")
      .find((line) => line.startsWith("| 1 |"))!;
    expect(firstRow).toContain("compinit");
  });

  test("renders a proportional self-percent bar", () => {
    expect(md).toContain("█");
    expect(md).toContain("33.4%");
  });

  test("emits a mermaid pie block with an other slice", () => {
    expect(md).toContain("```mermaid");
    expect(md).toContain("pie showData title Self time (ms)");
    expect(md).toContain('"compinit" : 12.21');
    expect(md).toContain('"other" :');
  });

  test("wraps the raw call graph in a collapsed details block", () => {
    expect(md).toContain("<details><summary>Full call graph</summary>");
    expect(md).toContain("</details>");
  });

  test("emits a note instead of empty scaffolding when nothing parses", () => {
    const md = renderMarkdown(parse("nothing here"));
    expect(md).toContain("No zprof profile captured");
    expect(md).not.toContain("```mermaid");
    expect(md).not.toContain("| # |");
  });
});

describe("renderTerminal", () => {
  const text = renderTerminal(parse(fixture));

  test("emits an aligned plain-text table without markdown or mermaid", () => {
    expect(text).toContain("Function");
    expect(text).toContain("compinit");
    expect(text).not.toContain("|");
    expect(text).not.toContain("```");
  });

  test("ranks compinit first", () => {
    const lines = text.split("\n");
    const dataRow = lines.find((l) => l.trimStart().startsWith("1"))!;
    expect(dataRow).toContain("compinit");
  });

  test("reports the note when nothing parses", () => {
    expect(renderTerminal(parse(""))).toBe("No zprof profile captured.");
  });
});
