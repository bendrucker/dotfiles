import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { loadTrace, sourceFiles } from "#trace/report";

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

// A source here cannot import #trace/*, since it sits outside the repo, so it
// builds its spans as plain objects.
function writeSource(name: string, body: string) {
  return box.write(`sources/${name}`, body);
}

describe("sourceFiles", () => {
  test("lists the .ts files beside a source directory, skipping tests", () => {
    writeSource("b.ts", "");
    writeSource("a.ts", "");
    writeSource("a.test.ts", "");
    writeSource("notes.md", "");
    expect(sourceFiles(box.path("sources")).map((file) => file.slice(box.dir.length))).toEqual(["/sources/a.ts", "/sources/b.ts"]);
  });

  test("answers empty for a directory that does not exist", () => {
    expect(sourceFiles(box.path("missing"))).toEqual([]);
  });
});

describe("loadTrace", () => {
  test("nests shell spans across processes", async () => {
    writeTrace();
    const tree = await loadTrace(box.path("trace"), []);
    expect(tree.nodes.map((node) => [node.span.name, node.parent?.span.name])).toEqual([
      ["bootstrap", undefined],
      ["brew bundle", "bootstrap"],
    ]);
  });

  test("puts a tool span under the innermost shell span covering it", async () => {
    writeTrace();
    const at = (seconds: number) => Number((T0 + BigInt(seconds) * S) / 1000n);
    const source = writeSource(
      "homebrew.ts",
      `export function collect(dir, shell) {
        return [{ name: "pour gum " + shell.length, start: ${at(100)}, end: ${at(130)}, error: false, source: "homebrew" }];
      }`,
    );
    const tree = await loadTrace(box.path("trace"), [source]);
    const pour = tree.nodes.find((node) => node.span.source === "homebrew");
    expect(pour?.span.name).toBe("pour gum 2");
    expect(pour?.parent?.span.name).toBe("brew bundle");
  });

  test("names a source that exports no collect", async () => {
    writeTrace();
    const source = writeSource("broken.ts", "export const nothing = 1;");
    expect(loadTrace(box.path("trace"), [source])).rejects.toThrow("exports no collect");
  });

  test("refuses a directory with no events", async () => {
    expect(loadTrace(box.mkdir("empty"), [])).rejects.toThrow("no events.tsv");
  });
});
