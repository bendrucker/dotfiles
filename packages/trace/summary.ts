import { duration } from "#trace/span";
import type { Node, Tree } from "#trace/tree";

export interface SummaryOptions {
  top: number;
  /** Seconds below which the tree hides a span. */
  min: number;
}

const GANTT_BARS = 40;
const GANTT_DEPTH = 2;
const GANTT_SHARE = 0.05;

export function formatDuration(us: number): string {
  const seconds = us / 1e6;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** Mermaid reads `:` as the start of a task's data and `#`/`;` as comment and statement breaks. */
function label(text: string): string {
  return text.replace(/[:;#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "(unnamed)";
}

function bounds(tree: Tree): { origin: number; total: number } {
  const origin = Math.min(...tree.roots.map((root) => root.span.start));
  return { origin, total: Math.max(...tree.roots.map((root) => root.span.end)) - origin };
}

function sectionOf(node: Node): Node {
  let current = node;
  while (current.parent?.parent) current = current.parent;
  return current;
}

/**
 * A gantt of the top two levels plus anything holding a twentieth of the run,
 * with the axis in elapsed time from the first span.
 */
export function gantt(tree: Tree): string {
  const { origin, total } = bounds(tree);
  const picked = tree.nodes
    .filter((node) => node.depth <= GANTT_DEPTH || duration(node.span) >= total * GANTT_SHARE)
    .sort((a, b) => duration(b.span) - duration(a.span))
    .slice(0, GANTT_BARS);
  const keep = new Set(picked);

  const sections = new Map<Node, string[]>();
  tree.nodes.forEach((node, index) => {
    if (!keep.has(node)) return;
    const start = Math.round((node.span.start - origin) / 1000);
    const end = Math.max(start + 1, Math.round((node.span.end - origin) / 1000));
    const tag = node.span.error ? "crit, " : "";
    const section = sectionOf(node);
    const lines = sections.get(section) ?? [];
    sections.set(section, lines);
    lines.push(`    ${label(`${node.span.name} ${formatDuration(duration(node.span))}`)} :${tag}s${index}, ${start}, ${end}`);
  });

  const body = [...sections].flatMap(([section, lines]) => [`    section ${label(section.span.name)}`, ...lines]);
  return ["```mermaid", "gantt", "    dateFormat x", "    axisFormat %M:%S", "    todayMarker off", ...body, "```"].join(
    "\n",
  );
}

/** The spans holding the most time of their own. */
export function topTable(tree: Tree, count: number): string {
  const rows = [...tree.nodes]
    .sort((a, b) => b.self - a.self)
    .slice(0, count)
    .map((node) => {
      const cells = [node.span.name, node.parent?.span.name ?? "", formatDuration(duration(node.span)), formatDuration(node.self)];
      return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
    });
  return ["| span | parent | total | self |", "| --- | --- | ---: | ---: |", ...rows].join("\n");
}

export function indentedTree(tree: Tree, minSeconds: number): { text: string; hidden: number } {
  const lines: string[] = [];
  const visit = (node: Node) => {
    if (duration(node.span) < minSeconds * 1e6) return;
    const mark = node.span.error ? "  ✗" : "";
    lines.push(`${"  ".repeat(node.depth)}${node.span.name}  ${formatDuration(duration(node.span))}${mark}`);
    for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return { text: lines.join("\n"), hidden: tree.nodes.length - lines.length };
}

export function renderSummary(tree: Tree, options: SummaryOptions): string {
  const failed = tree.roots.some((root) => root.span.error);
  const { total } = bounds(tree);
  const { text, hidden } = indentedTree(tree, options.min);

  return [
    `### Bootstrap trace: ${formatDuration(total)}, ${failed ? "failed" : "succeeded"}, ${tree.nodes.length} spans`,
    "",
    gantt(tree),
    "",
    `Top ${options.top} by self time:`,
    "",
    topTable(tree, options.top),
    "",
    "<details>",
    `<summary>Span tree (${hidden} under ${options.min}s hidden)</summary>`,
    "",
    "```text",
    text,
    "```",
    "",
    "</details>",
    "",
    "Every span, unpruned, is in this job's `bootstrap-trace` artifact as `otlp.json`, which Jaeger's Upload JSON and otel-desktop-viewer both load. The raw `events.tsv`, `lines/`, and `git/` records sit beside it.",
    "",
  ].join("\n");
}
