// What a to-do carries of a captured log: the tail, uncoloured.

// CSI sequences with numeric parameters and an alphabetic final byte, which is
// what gum's colours and the spinner's erase codes are. CSI only: an OSC title
// sequence carries text a reader may want and does not end in a letter, and
// carriage returns and escape forms without '[' are left alone rather than the
// strip being widened past what gum emits.
// oxlint-disable-next-line no-control-regex -- ESC is what the pattern is for.
const CSI = /\u001b\[[0-9;]*[a-zA-Z]/g;

const TRAILING_NEWLINES = /\n+$/;

export function stripCsi(text: string): string {
  return text.replace(CSI, "");
}

export function tailLines(text: string, count: number): string {
  const lines = text.split("\n");
  // The newline a log ends with terminates its last line rather than opening
  // another one.
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count).join("\n");
}

// A failure ends at the end of its log and a Things note is finite, so the tail
// is the part worth keeping. No trailing blank lines, so the note's closing fence
// sits against the text rather than adrift below it.
export function logExcerpt(log: string, lines: number): string {
  return stripCsi(tailLines(log, lines)).replace(TRAILING_NEWLINES, "");
}
