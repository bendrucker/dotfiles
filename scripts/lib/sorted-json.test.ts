import { describe, expect, test } from "bun:test";
import { byCodeUnit, canonicalJson, parseJson } from "./sorted-json.ts";

describe("parseJson", () => {
  test("reads a document", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  // An editor that saved a settings file with a byte order mark left valid JSON
  // behind it, so the mark is not a reason to call the file unreadable.
  test("reads past a byte order mark", () => {
    expect(parseJson('﻿{"a":1}')).toEqual({ a: 1 });
  });

  // Reported rather than raised, because every caller treats a file it cannot
  // parse as one it has nothing to say about.
  test("answers nothing for text that is not JSON", () => {
    expect(parseJson("not json")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
  });
});

describe("canonicalJson", () => {
  test("orders the keys of every object, however deeply nested", () => {
    expect(canonicalJson('{"b":{"d":1,"c":2},"a":[{"f":1,"e":2}]}')).toMatchInlineSnapshot(`
      "{
        "a": [
          {
            "e": 2,
            "f": 1
          }
        ],
        "b": {
          "c": 2,
          "d": 1
        }
      }
      "
    `);
  });

  test("leaves array order alone", () => {
    expect(canonicalJson("[3,1,2]")).toBe("[\n  3,\n  1,\n  2\n]\n");
  });

  // Two spellings of the same document reduce to one text, which is what lets a
  // reformat be told from an edit.
  test("reduces a reformat to the same text", () => {
    expect(canonicalJson('{"b":2,"a":1}')).toBe(canonicalJson('{\n  "a": 1,\n  "b": 2\n}\n'));
  });

  // The reason this goes through jq at all. Both of these are 1700000000000000000
  // as a JavaScript double, and bin/claude-upgrade answers "the file did not
  // change" by comparing two canonical texts before running `git checkout HEAD --`
  // over the working copy.
  test("keeps integers a double would collapse apart", () => {
    expect(canonicalJson('{"stamp":1700000000000000001}')).not.toBe(
      canonicalJson('{"stamp":1700000000000000002}'),
    );
  });

  test("reads past a byte order mark", () => {
    expect(canonicalJson('\uFEFF{"a":1}')).toBe(canonicalJson('{"a":1}'));
  });

  // The comparison bin/claude-upgrade makes over everything outside one key,
  // rather than deleting it from a parsed object and re-encoding.
  test("applies the filter it is given", () => {
    expect(canonicalJson('{"hooks":{"x":1},"a":1}', "del(.hooks)")).toBe(canonicalJson('{"a":1}'));
  });

  // Undefined, never a text two of which could compare equal: every caller reads
  // it as "cannot compare" and none as "unchanged".
  test("answers nothing for text that is not JSON", () => {
    expect(canonicalJson("not json")).toBeUndefined();
  });
});

// Ordered by code unit, so the text does not move with the ambient locale's
// collation.
describe("byCodeUnit", () => {
  test("orders uppercase ahead of lowercase", () => {
    expect(["b", "A", "a", "B"].sort(byCodeUnit)).toEqual(["A", "B", "a", "b"]);
  });

  test("reports equal values as equal", () => {
    expect(byCodeUnit("a", "a")).toBe(0);
  });
});
