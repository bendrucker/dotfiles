import { expect, test } from "bun:test";
import { alignColumns } from "./table";

test.each<{ name: string; rows: string[][]; aligned: string[] }>([
  { name: "plain cells", rows: [["a", "bb", "x"], ["ccc", "d", "y"]], aligned: ["a    bb  x", "ccc  d   y"] },
  {
    name: "a colored cell pads by its visible width",
    rows: [["\x1b[31mab\x1b[0m", "x"], ["abcd", "y"]],
    aligned: ["\x1b[31mab\x1b[0m    x", "abcd  y"],
  },
  { name: "the last column carries no padding", rows: [["a", ""], ["bb", "z"]], aligned: ["a", "bb  z"] },
])("$name", ({ rows, aligned }) => {
  expect(alignColumns(rows)).toEqual(aligned);
});
