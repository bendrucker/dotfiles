import { describe, expect, test } from "bun:test";
import type { Span } from "#trace/span";
import { buildTree } from "#trace/tree";

function makeSpan(name: string, start: number, end: number, parent?: Span): Span {
  return { name, start, end, error: false, source: "shell", parent };
}

describe("buildTree", () => {
  test("orders parents before children and siblings by start, with depths", () => {
    const root = makeSpan("root", 0, 100);
    const late = makeSpan("late", 50, 60, root);
    const early = makeSpan("early", 10, 20, root);
    const leaf = makeSpan("leaf", 12, 15, early);
    const tree = buildTree([leaf, late, root, early]);
    expect(tree.nodes.map((node) => [node.span.name, node.depth])).toEqual([
      ["root", 0],
      ["early", 1],
      ["leaf", 2],
      ["late", 1],
    ]);
    expect(tree.roots.map((node) => node.span.name)).toEqual(["root"]);
  });

  test("self time subtracts the union of children, so overlapping ones count once", () => {
    const root = makeSpan("brew bundle", 0, 100);
    const tree = buildTree([root, makeSpan("fetch a", 10, 40, root), makeSpan("fetch b", 30, 50, root), makeSpan("pour", 90, 120, root)]);
    expect(tree.nodes[0]?.self).toBe(100 - 40 - 10);
  });

  test("assigns hex ids of OTLP's widths, unique per span", () => {
    const root = makeSpan("root", 0, 10);
    const tree = buildTree([root, makeSpan("a", 1, 2, root), makeSpan("b", 3, 4, root)]);
    expect(tree.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const node of tree.nodes) expect(node.id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(tree.nodes.map((node) => node.id)).size).toBe(3);
  });

  test("a span whose parent is not in the set becomes a root", () => {
    const tree = buildTree([makeSpan("orphan", 0, 1, makeSpan("missing", 0, 2))]);
    expect(tree.roots.map((node) => node.span.name)).toEqual(["orphan"]);
  });
});
