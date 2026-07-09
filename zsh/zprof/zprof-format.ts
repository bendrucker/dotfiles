#!/usr/bin/env bun
//
// Format a `ZPROF=1 zsh -i -c exit` capture into a scannable ranked view.
//
//   ZPROF=1 zsh -i -c exit 2>&1 | bun zprof-format.ts                    # markdown (default)
//   ZPROF=1 zsh -i -c exit 2>&1 | bun zprof-format.ts --format terminal  # aligned plain text
//   ... | bun zprof-format.ts --top 12                                   # widen pie/bar list
//
// Markdown output nests under an existing `## Shell Startup Benchmark` heading and is
// safe to append straight to $GITHUB_STEP_SUMMARY.

import { parseArgs } from "node:util";

export interface Row {
  rank: number;
  calls: number;
  totalMs: number;
  totalAvg: number;
  totalPct: number;
  selfMs: number;
  selfAvg: number;
  selfPct: number;
  name: string;
}

export interface Profile {
  rows: Row[];
  callGraph: string;
}

// OSC sequences (shell-integration 1337 codes, terminated by BEL or ESC-backslash)
// and CSI SGR color codes leak into the capture. Strip both so the summary is clean text.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR = /\x1b\[[0-9;]*m/g;

const ROW =
  /^\s*(\d+)\)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)%\s+(.+)$/;

const SEPARATOR = /^-{5,}\s*$/;
const HEADER = /^\s*num\s+calls\b.*\btime\b.*\bself\b.*\bname\s*$/;

export function stripControl(raw: string): string {
  return raw.replace(OSC, "").replace(SGR, "");
}

export function parse(raw: string): Profile {
  const lines = stripControl(raw).split("\n");

  const headerIndex = lines.findIndex((line) => HEADER.test(line));
  if (headerIndex === -1) {
    return { rows: [], callGraph: "" };
  }

  // The flat profile is the first contiguous run of rows after the header (and its
  // `----` underline). A blank line or separator closes it; everything past that is
  // the per-function call graph, kept verbatim for drill-down.
  const rows: Row[] = [];
  let cursor = headerIndex + 1;
  let started = false;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    const match = line.match(ROW);
    if (match) {
      started = true;
      rows.push({
        rank: Number(match[1]),
        calls: Number(match[2]),
        totalMs: Number(match[3]),
        totalAvg: Number(match[4]),
        totalPct: Number(match[5]),
        selfMs: Number(match[6]),
        selfAvg: Number(match[7]),
        selfPct: Number(match[8]),
        name: match[9].trim(),
      });
      continue;
    }
    if (!started && (SEPARATOR.test(line) || line.trim() === "")) {
      continue; // skip the header underline / leading blanks
    }
    if (started) break; // first non-row line after the flat table ends it
  }

  const callGraph = lines
    .slice(cursor)
    .join("\n")
    .replace(/^[\s-]*\n/, "")
    .trimEnd();

  return { rows, callGraph };
}

function bySelfDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => b.selfMs - a.selfMs);
}

export function bar(pct: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.round((pct / max) * width) : 0;
  const clamped = Math.max(0, Math.min(width, filled));
  return "█".repeat(clamped) + "░".repeat(width - clamped);
}

const NOTE = "_No zprof profile captured._";

function escapeCell(name: string): string {
  return name.replace(/\|/g, "\\|");
}

export function renderMarkdown(profile: Profile, top = 8): string {
  const out: string[] = ["### Startup profile", ""];
  const rows = bySelfDesc(profile.rows);

  if (rows.length === 0) {
    out.push(NOTE, "");
    return out.join("\n");
  }

  const maxPct = rows[0].selfPct;
  out.push(
    "| # | Function | Calls | Self (ms) | Self % | Total (ms) |",
    "|---|----------|------:|----------:|--------|-----------:|",
  );
  rows.forEach((row, index) => {
    const pct = `${bar(row.selfPct, maxPct)} ${row.selfPct.toFixed(1)}%`;
    out.push(
      `| ${index + 1} | ${escapeCell(row.name)} | ${row.calls} | ` +
        `${row.selfMs.toFixed(2)} | ${pct} | ${row.totalMs.toFixed(2)} |`,
    );
  });
  out.push("");

  const slices = rows.slice(0, top);
  const rest = rows.slice(top).reduce((sum, row) => sum + row.selfMs, 0);
  out.push("```mermaid", "pie showData title Self time (ms)");
  for (const row of slices) {
    out.push(`    "${row.name.replace(/"/g, "'")}" : ${row.selfMs.toFixed(2)}`);
  }
  if (rest > 0) {
    out.push(`    "other" : ${rest.toFixed(2)}`);
  }
  out.push("```", "");

  if (profile.callGraph) {
    out.push(
      "<details><summary>Full call graph</summary>",
      "",
      "```",
      profile.callGraph,
      "```",
      "",
      "</details>",
      "",
    );
  }

  return out.join("\n");
}

export function renderTerminal(profile: Profile, top = 8): string {
  const rows = bySelfDesc(profile.rows);
  if (rows.length === 0) {
    return "No zprof profile captured.";
  }

  const maxPct = rows[0].selfPct;
  const headers = ["#", "Function", "Calls", "Self ms", "Total ms", "Self %"];
  const table = rows.slice(0, top).map((row, index) => [
    String(index + 1),
    row.name,
    String(row.calls),
    row.selfMs.toFixed(2),
    row.totalMs.toFixed(2),
    `${bar(row.selfPct, maxPct)} ${row.selfPct.toFixed(1)}%`,
  ]);

  const widths = headers.map((header, col) =>
    Math.max(header.length, ...table.map((cells) => cells[col].length)),
  );
  const rightAlign = new Set([0, 2, 3, 4]);
  const format = (cells: string[]) =>
    cells
      .map((cell, col) =>
        rightAlign.has(col) ? cell.padStart(widths[col]) : cell.padEnd(widths[col]),
      )
      .join("  ")
      .trimEnd();

  const lines = [format(headers), format(widths.map((w) => "─".repeat(w)))];
  for (const cells of table) lines.push(format(cells));
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      format: { type: "string", default: "markdown" },
      top: { type: "string", default: "8" },
    },
  });

  const top = Number(values.top) || 8;
  const profile = parse(await Bun.stdin.text());
  const rendered =
    values.format === "terminal"
      ? renderTerminal(profile, top)
      : renderMarkdown(profile, top);
  process.stdout.write(rendered + "\n");
}
