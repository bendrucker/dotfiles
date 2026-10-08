import { duration, type Span } from "#trace/span";

export function covers(outer: Pick<Span, "start" | "end">, inner: Pick<Span, "start" | "end">): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Parent each shell span on the innermost one enclosing it, across processes.
 * The bootstrap path runs its steps one after another, so enclosing intervals
 * nest cleanly. An exact tie goes to the span written first, which is the one
 * that began first: a parent's B line always precedes its child's.
 */
export function nestShell(spans: Span[]): void {
  const order = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: Span[] = [];
  for (const span of order) {
    while (stack.length > 0 && !covers(stack[stack.length - 1] as Span, span)) stack.pop();
    span.parent = stack[stack.length - 1];
    stack.push(span);
  }
}

export function deepestCovering(shell: Span[], start: number, end: number): Span | undefined {
  let best: Span | undefined;
  for (const span of shell) {
    if (!covers(span, { start, end })) continue;
    if (!best || duration(span) <= duration(best)) best = span;
  }
  return best;
}
