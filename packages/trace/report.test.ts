import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { loadTrace } from "#trace/report";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("trace-report");
});

afterEach(() => {
  box.remove();
});

const S = 1_000_000_000n;
const T0 = 1791479525n * S;

function ev(kind: string, seconds: number, pid: number, status = 0, name = ""): string {
  return [kind, T0 + BigInt(seconds) * S, pid, status, name].join("\t");
}

function writeTrace() {
  box.write(
    "trace/events.tsv",
    [ev("B", 0, 1, 0, "bootstrap"), ev("B", 10, 2, 0, "brew bundle"), ev("E", 280, 2), ev("E", 300, 1), ""].join("\n"),
  );
}

describe("loadTrace", () => {
  test("nests shell spans across processes", () => {
    writeTrace();
    const tree = loadTrace(box.path("trace"));
    expect(tree.nodes.map((node) => [node.span.name, node.parent?.span.name])).toEqual([
      ["bootstrap", undefined],
      ["brew bundle", "bootstrap"],
    ]);
  });

  test("refuses a directory with no events", () => {
    expect(() => loadTrace(box.mkdir("empty"))).toThrow("no events.tsv");
  });
});
