/**
 * One timed step. Times are microseconds since the epoch: nanoseconds would pass
 * Number.MAX_SAFE_INTEGER, and the shell's clock is no finer than a microsecond
 * on most of the shells that write it.
 */
export interface Span {
  name: string;
  start: number;
  end: number;
  error: boolean;
  /** "shell", or the tool source that derived it. */
  source: string;
  pid?: number;
  status?: number;
  attributes?: Record<string, string | number | boolean>;
  /** Set by a source that knows better than time containment, such as git's sid chain. */
  parent?: Span;
}

export function duration(span: Pick<Span, "start" | "end">): number {
  return span.end - span.start;
}

export function nsToUs(ns: string | bigint): number {
  return Number(BigInt(ns) / 1000n);
}
