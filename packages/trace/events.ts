import { nsToUs, type Span } from "#trace/span";

/**
 * Pair the B and E lines of events.tsv into shell spans, last opened first
 * closed within each pid. An X line is a process exiting: whatever it left open
 * closes there with its exit status, which is how a set -e failure that skipped
 * every trace_end still ends its spans.
 *
 * A process can die without its X line: zsh skips the EXIT trap when set -e
 * fires inside a function, and nothing runs one after a SIGKILL. Its open spans
 * close, unterminated and failed, when the span that began before them in
 * another process closes, since that is the caller noticing. Whatever is still
 * open at the end of the file closes at the last event.
 */
export function parseEvents(text: string): Span[] {
  const open = new Map<number, Span[]>();
  const spans: Span[] = [];
  let last = 0;

  const close = (span: Span, at: number, status: number) => {
    span.end = at;
    span.status = status;
    span.error = status !== 0;
    for (const [pid, stack] of open) {
      if (pid === span.pid) continue;
      for (let top = stack.at(-1); top && top.start >= span.start; top = stack.at(-1)) {
        stack.pop();
        unterminated(top, at);
      }
    }
  };

  for (const line of text.split("\n")) {
    const [kind, ns, pidField, statusField = "0", ...name] = line.split("\t");
    if (!kind || !ns || !/^\d+$/.test(ns) || !pidField) continue;
    const at = nsToUs(ns);
    const pid = Number(pidField);
    const status = Number(statusField) || 0;
    last = Math.max(last, at);

    const stack = open.get(pid) ?? [];
    open.set(pid, stack);
    if (kind === "B") {
      const span: Span = { name: name.join(" "), start: at, end: at, error: false, source: "shell", pid };
      stack.push(span);
      spans.push(span);
    } else if (kind === "E") {
      const span = stack.pop();
      if (span) close(span, at, status);
    } else if (kind === "X") {
      for (let span = stack.pop(); span; span = stack.pop()) close(span, at, status);
    }
  }

  for (const stack of open.values()) for (const span of stack) unterminated(span, last);
  return spans;
}

function unterminated(span: Span, at: number): void {
  span.end = at;
  span.error = true;
  span.attributes = { ...span.attributes, "trace.unterminated": true };
}
