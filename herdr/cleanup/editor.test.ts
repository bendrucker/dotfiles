import { describe, expect, test } from "bun:test";
import { apply, parseKeys, view, type Draft, type Key } from "./editor";
import { frame } from "./prompt";

describe("parseKeys", () => {
  test.each<{ name: string; input: string; keys: Key[] }>([
    { name: "enter sends", input: "\r", keys: [{ type: "submit" }] },
    { name: "shift+enter under the kitty protocol is a newline", input: "\x1b[13;2u", keys: [{ type: "newline" }] },
    { name: "alt+enter under the kitty protocol is a newline", input: "\x1b[13;3u", keys: [{ type: "newline" }] },
    { name: "a plain kitty enter sends", input: "\x1b[13u", keys: [{ type: "submit" }] },
    { name: "legacy alt+enter is a newline", input: "\x1b\r", keys: [{ type: "newline" }] },
    { name: "ctrl+j is a newline", input: "\n", keys: [{ type: "newline" }] },
    { name: "kitty ctrl+j is a newline", input: "\x1b[106;5u", keys: [{ type: "newline" }] },
    { name: "kitty esc cancels", input: "\x1b[27u", keys: [{ type: "cancel" }] },
    { name: "a lone esc cancels", input: "\x1b", keys: [{ type: "cancel" }] },
    { name: "ctrl+c cancels", input: "\x03", keys: [{ type: "cancel" }] },
    { name: "kitty ctrl+c cancels", input: "\x1b[99;5u", keys: [{ type: "cancel" }] },
    { name: "backspace", input: "\x7f", keys: [{ type: "backspace" }] },
    { name: "arrows with and without modifiers", input: "\x1b[A\x1b[1;2D", keys: [{ type: "up" }, { type: "left" }] },
    { name: "home, end, and delete", input: "\x1b[H\x1b[4~\x1b[3~", keys: [{ type: "home" }, { type: "end" }, { type: "delete" }] },
    { name: "a run of text is one key", input: "héllo there", keys: [{ type: "text", text: "héllo there" }] },
    { name: "a kitty-encoded printable key", input: "\x1b[97u", keys: [{ type: "text", text: "a" }] },
    {
      name: "a paste keeps its newlines and does not send",
      input: "\x1b[200~one\r\ntwo\r\x1b[201~",
      keys: [{ type: "text", text: "one\ntwo\n" }],
    },
    { name: "an unknown sequence is dropped", input: "a\x1b[99Zb", keys: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
  ])("$name", ({ input, keys }) => {
    expect(parseKeys(input)).toEqual(keys);
  });
});

function draft(marked: string): Draft {
  return { text: marked.replace("|", ""), cursor: marked.indexOf("|") };
}

function marked(state: Draft): string {
  return `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;
}

describe("apply", () => {
  test.each<{ name: string; before: string; key: Key; after: string }>([
    { name: "inserts text at the cursor", before: "ab|c", key: { type: "text", text: "X" }, after: "abX|c" },
    { name: "inserts a newline", before: "ab|c", key: { type: "newline" }, after: "ab\n|c" },
    { name: "backspace joins lines", before: "ab\n|c", key: { type: "backspace" }, after: "ab|c" },
    { name: "backspace at the start does nothing", before: "|abc", key: { type: "backspace" }, after: "|abc" },
    { name: "delete removes the next character", before: "a|bc", key: { type: "delete" }, after: "a|c" },
    { name: "left stops at the start", before: "|abc", key: { type: "left" }, after: "|abc" },
    { name: "right stops at the end", before: "abc|", key: { type: "right" }, after: "abc|" },
    { name: "up keeps the column", before: "abcd\nab|cd", key: { type: "up" }, after: "ab|cd\nabcd" },
    { name: "up onto a shorter line lands at its end", before: "ab\nabcd|", key: { type: "up" }, after: "ab|\nabcd" },
    { name: "up on the first line goes to the start", before: "ab|c", key: { type: "up" }, after: "|abc" },
    { name: "down keeps the column", before: "a|bcd\nabcd", key: { type: "down" }, after: "abcd\na|bcd" },
    { name: "down onto a shorter line lands at its end", before: "abc|d\nab\nx", key: { type: "down" }, after: "abcd\nab|\nx" },
    { name: "down on the last line goes to the end", before: "a|bc", key: { type: "down" }, after: "abc|" },
    { name: "home goes to the line start", before: "ab\ncd|e", key: { type: "home" }, after: "ab\n|cde" },
    { name: "end goes to the line end", before: "a|b\ncde", key: { type: "end" }, after: "ab|\ncde" },
  ])("$name", ({ before, key, after }) => {
    expect(marked(apply(draft(before), key))).toBe(after);
  });
});

describe("view", () => {
  test.each<{ name: string; draft: string; rows: string[]; row: number; column: number }>([
    { name: "short lines stay whole", draft: "ab\nc|d", rows: ["ab", "cd"], row: 1, column: 1 },
    { name: "a long line wraps", draft: "abcdef|g", rows: ["abcd", "efg"], row: 1, column: 2 },
    { name: "a cursor at a wrap point opens the next row", draft: "abcd|ef", rows: ["abcd", "ef"], row: 1, column: 0 },
    { name: "a cursor at the end of a full row stays on it", draft: "abcd|", rows: ["abcd"], row: 0, column: 4 },
    { name: "an empty line is a row", draft: "ab\n\n|", rows: ["ab", "", ""], row: 2, column: 0 },
  ])("$name", ({ draft: text, rows, row, column }) => {
    expect(view(draft(text), 4)).toEqual({ rows, row, column });
  });
});

test("the frame shows the title, the text, and the keys, with the cursor after the text", () => {
  const shown = frame(draft("[herdr-cleanup] stale.\nRe-check.|"), "Wake demo", 40);
  expect(Bun.stripANSI(shown).split("\r\n")).toMatchInlineSnapshot(`
    [
      "Wake demo",
      "",
      "┃ [herdr-cleanup] stale.",
      "┃ Re-check.",
      "┃ ",
      "┃ ",
      "┃ ",
      "┃ ",
      "",
      "enter send · shift+enter new line · esc cancel",
    ]
  `);
  expect(shown).toEndWith("\x1b[4;12H");
});
