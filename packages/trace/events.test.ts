import { describe, expect, test } from "bun:test";
import { parseEvents } from "#trace/events";

/** One events.tsv line, at a time given in seconds. */
function ev(kind: "B" | "E" | "X", seconds: number, pid: number, status = 0, name = ""): string {
  return [kind, BigInt(seconds * 1e6) * 1000n, pid, status, name].join("\t");
}

function summarize(text: string) {
  return parseEvents(text).map(({ name, start, end, error, pid }) => ({ name, start: start / 1e6, end: end / 1e6, error, pid }));
}

describe("parseEvents", () => {
  test("pairs B and E last-in first-out within a pid", () => {
    const text = [ev("B", 1, 10, 0, "outer"), ev("B", 2, 10, 0, "inner"), ev("E", 3, 10), ev("E", 4, 10), ""].join("\n");
    expect(summarize(text)).toEqual([
      { name: "outer", start: 1, end: 4, error: false, pid: 10 },
      { name: "inner", start: 2, end: 3, error: false, pid: 10 },
    ]);
  });

  test("keeps interleaved pids apart", () => {
    const text = [ev("B", 1, 10, 0, "parent"), ev("B", 2, 20, 0, "child"), ev("E", 3, 20), ev("E", 4, 10)].join("\n");
    expect(summarize(text).map(({ name, end }) => [name, end])).toEqual([
      ["parent", 4],
      ["child", 3],
    ]);
  });

  test("an X line closes everything its pid left open with the exit status", () => {
    const spans = parseEvents([ev("B", 1, 10, 0, "a"), ev("B", 2, 10, 0, "b"), ev("X", 5, 10, 1)].join("\n"));
    expect(spans.map(({ end, status, error }) => ({ end: end / 1e6, status, error }))).toEqual([
      { end: 5, status: 1, error: true },
      { end: 5, status: 1, error: true },
    ]);
  });

  test("an E with a nonzero status is an error", () => {
    expect(parseEvents([ev("B", 1, 10, 0, "a"), ev("E", 2, 10, 3)].join("\n"))[0]).toMatchObject({ status: 3, error: true });
  });

  // zsh skips its EXIT trap when set -e fires inside a function.
  test("a child that died without an X closes when the span around it does", () => {
    const text = [ev("B", 1, 10, 0, "install"), ev("B", 2, 20, 0, "topic"), ev("E", 6, 10, 1), ev("B", 7, 10, 0, "next"), ev("E", 8, 10)].join("\n");
    const [install, topic, next] = parseEvents(text);
    expect(topic).toMatchObject({ end: 6e6, error: true, attributes: { "trace.unterminated": true } });
    expect(install).toMatchObject({ end: 6e6, error: true });
    expect(next).toMatchObject({ error: false });
  });

  test("a span nothing closed ends at the last event, as an error", () => {
    const [root] = parseEvents([ev("B", 1, 10, 0, "root"), ev("B", 2, 20, 0, "x"), ev("E", 9, 20)].join("\n"));
    expect(root).toMatchObject({ end: 9e6, error: true, attributes: { "trace.unterminated": true } });
  });

  test("joins a name that held tabs and skips lines it cannot read", () => {
    const text = ["garbage", ev("E", 1, 99), "B\tnot-a-time\t1\t0\tx", ev("B", 2, 10, 0, "a\tb"), ev("E", 3, 10)].join("\n");
    expect(summarize(text).map(({ name }) => name)).toEqual(["a b"]);
  });

  test("keeps nanosecond input exact to the microsecond", () => {
    const [span] = parseEvents(["B\t1791479525635050058\t1\t0\tx", "E\t1791479525640052080\t1\t0\t"].join("\n"));
    expect(span?.start).toBe(1791479525635050);
    expect(span?.end).toBe(1791479525640052);
  });
});
