import { describe, expect, test } from "bun:test";
import { logExcerpt, stripCsi, tailLines } from "#jobs/excerpt";

const ESC = "\u001b";

describe("tailLines", () => {
  const numbered = (count: number): string =>
    `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

  test("keeps only the last lines of a log longer than the count", () => {
    const kept = tailLines(numbered(153), 100).split("\n");
    expect(kept.length).toBe(100);
    expect(kept[0]).toBe("line 54");
    expect(kept.at(-1)).toBe("line 153");
  });

  test("keeps a log shorter than the count whole", () => {
    expect(tailLines("one\ntwo\n", 100)).toBe("one\ntwo");
  });

  // The newline a log ends with terminates its last line. Counting it as a line
  // of its own costs a line of the tail and leaves the excerpt one short.
  test("reads the terminating newline as part of the last line", () => {
    expect(tailLines("first\nsecond\n", 1)).toBe("second");
  });

  test("keeps a last line that has no terminating newline", () => {
    expect(tailLines("first\nsecond", 1)).toBe("second");
  });
});

describe("stripCsi", () => {
  test("strips the colour escapes the child tools write", () => {
    expect(stripCsi(`${ESC}[31mfatal${ESC}[0m: could not read`)).toBe("fatal: could not read");
  });

  test("strips a cursor-positioning escape", () => {
    expect(stripCsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe("progress");
  });

  // The pattern covers CSI sequences with an alphabetic final byte and nothing
  // else, so a wider one cannot quietly eat log text.
  test("leaves an escape without a bracket alone", () => {
    expect(stripCsi(`${ESC}(Btext`)).toBe(`${ESC}(Btext`);
  });

  // An OSC sequence carries the title text a reader may want, and it does not
  // end in a letter, so the CSI pattern would take an arbitrary bite out of it.
  test("leaves an OSC title sequence alone", () => {
    const osc = `${ESC}]0;installing${ESC}done`;
    expect(stripCsi(osc)).toBe(osc);
  });
});

describe("logExcerpt", () => {
  test("keeps the tail, uncoloured", () => {
    expect(logExcerpt(`one\n${ESC}[31mtwo${ESC}[0m\n`, 1)).toBe("two");
  });

  // The note's closing fence sits directly after the last log line.
  test("drops the trailing blank lines a step leaves behind", () => {
    expect(logExcerpt("done\n\n\n", 100)).toBe("done");
  });
});
