import { describe, expect, test } from "bun:test";
import { toOtlp } from "#trace/otlp";
import type { Span } from "#trace/span";
import { buildTree } from "#trace/tree";

describe("toOtlp", () => {
  const root: Span = { name: "bootstrap", start: 1791479525635050, end: 1791479529635050, error: true, source: "shell", pid: 7, status: 1 };
  const child: Span = {
    name: "pour gum",
    start: 1791479526000000,
    end: 1791479527000000,
    error: false,
    source: "homebrew",
    parent: root,
    attributes: { "homebrew.version": "0.17.0", "trace.unterminated": false, size: 1.5 },
  };
  const tree = buildTree([root, child]);
  const [resourceSpans] = toOtlp(tree, { "service.name": "dotfiles-bootstrap" }).resourceSpans;
  const spans = resourceSpans?.scopeSpans[0]?.spans ?? [];

  test("links each span to its parent's id under one trace", () => {
    expect(spans.map((span) => span.traceId)).toEqual([tree.traceId, tree.traceId]);
    expect(spans[0]).not.toHaveProperty("parentSpanId");
    expect(spans[1]?.parentSpanId).toBe(spans[0]?.spanId);
  });

  test("writes nanosecond times as decimal strings", () => {
    expect(spans[0]?.startTimeUnixNano).toBe("1791479525635050000");
    expect(spans[0]?.endTimeUnixNano).toBe("1791479529635050000");
  });

  test("marks a failed span with the error status and its exit code", () => {
    expect(spans[0]?.status).toEqual({ code: 2, message: "exited 1" });
    expect(spans[1]?.status).toEqual({ code: 0 });
    expect(spans[0]?.attributes).toContainEqual({ key: "process.exit_code", value: { intValue: "1" } });
  });

  test("types each attribute value", () => {
    expect(spans[1]?.attributes).toEqual([
      { key: "trace.source", value: { stringValue: "homebrew" } },
      { key: "homebrew.version", value: { stringValue: "0.17.0" } },
      { key: "trace.unterminated", value: { boolValue: false } },
      { key: "size", value: { doubleValue: 1.5 } },
    ]);
  });

  test("carries the resource attributes", () => {
    expect(resourceSpans?.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "dotfiles-bootstrap" } }]);
  });
});
