import { duration, type Span } from "#trace/span";

export interface Node {
  span: Span;
  id: string;
  parent?: Node;
  children: Node[];
  depth: number;
  /** Time no child covers. Children may overlap, as parallel downloads do, so this subtracts their union. */
  self: number;
}

export interface Tree {
  traceId: string;
  roots: Node[];
  /** Every node, parents before children, siblings by start. */
  nodes: Node[];
}

export function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

/** Link spans by their `parent` field into a tree, assigning the trace and span ids. */
export function buildTree(spans: Span[]): Tree {
  const nodes = new Map<Span, Node>();
  for (const span of spans) nodes.set(span, { span, id: randomHex(8), children: [], depth: 0, self: 0 });

  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parent && nodes.get(node.span.parent);
    node.parent = parent;
    (parent ? parent.children : roots).push(node);
  }

  const ordered: Node[] = [];
  const visit = (node: Node, depth: number) => {
    node.depth = depth;
    node.children.sort((a, b) => a.span.start - b.span.start);
    node.self = duration(node.span) - covered(node);
    ordered.push(node);
    for (const child of node.children) visit(child, depth + 1);
  };
  roots.sort((a, b) => a.span.start - b.span.start);
  for (const root of roots) visit(root, 0);

  return { traceId: randomHex(16), roots, nodes: ordered };
}

function covered(node: Node): number {
  const { start, end } = node.span;
  const intervals = node.children
    .map((child) => [Math.max(start, child.span.start), Math.min(end, child.span.end)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let reach = start;
  for (const [a, b] of intervals) {
    if (b <= reach) continue;
    total += b - Math.max(a, reach);
    reach = b;
  }
  return total;
}
