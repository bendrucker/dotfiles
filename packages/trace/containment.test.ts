import { describe, expect, test } from "bun:test";
import { deepestCovering, nestShell } from "#trace/containment";
import type { Span } from "#trace/span";

function makeSpan(name: string, start: number, end: number, overrides: Partial<Span> = {}): Span {
  return { name, start, end, error: false, source: "shell", ...overrides };
}

describe("nestShell", () => {
  test("parents each span on the innermost enclosing one, across pids", () => {
    const root = makeSpan("bootstrap", 0, 100, { pid: 1 });
    const dotf = makeSpan("install", 10, 90, { pid: 1 });
    const bundle = makeSpan("brew bundle", 20, 60, { pid: 2 });
    const topics = makeSpan("install-topics", 61, 89, { pid: 2 });
    const topic = makeSpan("topic herdr", 62, 80, { pid: 3 });
    nestShell([topic, bundle, root, topics, dotf]);
    expect([root, dotf, bundle, topics, topic].map((span) => span.parent?.name)).toEqual([
      undefined,
      "bootstrap",
      "install",
      "install",
      "install-topics",
    ]);
  });

  test("an exact tie nests the later-written span under the earlier", () => {
    const first = makeSpan("first", 0, 10);
    const second = makeSpan("second", 0, 10);
    nestShell([first, second]);
    expect(second.parent).toBe(first);
    expect(first.parent).toBeUndefined();
  });

  test("leaves siblings that follow one another unrelated", () => {
    const a = makeSpan("a", 0, 5);
    const b = makeSpan("b", 5, 9);
    nestShell([a, b]);
    expect(b.parent).toBeUndefined();
  });
});

describe("deepestCovering", () => {
  const root = makeSpan("root", 0, 100);
  const bundle = makeSpan("brew bundle", 10, 50);
  const later = makeSpan("later", 60, 90);

  test.each<{ name: string; start: number; end: number; expected: string | undefined }>([
    { name: "inside the innermost span", start: 20, end: 30, expected: "brew bundle" },
    { name: "between children", start: 52, end: 58, expected: "root" },
    { name: "straddling two children", start: 40, end: 70, expected: "root" },
    { name: "outside everything", start: 150, end: 160, expected: undefined },
  ])("$name", ({ start, end, expected }) => {
    expect(deepestCovering([root, bundle, later], start, end)?.name).toBe(expected);
  });
});
