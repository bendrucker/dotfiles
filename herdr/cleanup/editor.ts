// A multi-line prompt editor where enter sends and shift+enter starts a new
// line. gum write binds its newline to ctrl+j alone and cannot be rebound.
// Telling shift+enter from enter needs the kitty keyboard protocol, which the
// executable turns on. ctrl+j and alt+enter insert a newline wherever it is off.

export type Key =
  | { type: "text"; text: string }
  | { type: "newline" | "submit" | "cancel" | "backspace" | "delete" | "left" | "right" | "up" | "down" | "home" | "end" };

export interface Draft {
  text: string;
  cursor: number;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_FINAL: Record<string, Key["type"]> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE: Record<string, Key["type"]> = { "1": "home", "3": "delete", "4": "end", "7": "home", "8": "end" };

// A kitty `CSI codepoint;modifiers u` key. The modifier field is 1 + a bitmask
// where shift is 1, alt 2, and ctrl 4.
function kittyKey(codepoint: number, modifiers: number): Key | undefined {
  const bits = Math.max(0, modifiers - 1);
  const ctrl = (bits & 4) !== 0;
  if (codepoint === 13) return bits & 3 ? { type: "newline" } : { type: "submit" };
  if (codepoint === 27) return { type: "cancel" };
  if (codepoint === 127 || codepoint === 8) return { type: "backspace" };
  if (ctrl && (codepoint === 99 || codepoint === 100)) return { type: "cancel" };
  if (ctrl && codepoint === 106) return { type: "newline" };
  if (ctrl || codepoint < 32) return undefined;
  return { type: "text", text: String.fromCodePoint(codepoint) };
}

// Reads one escape sequence at the start of `input`, returning the key and how
// many characters it used.
function escape(input: string): [Key | undefined, number] {
  if (input.startsWith(PASTE_START)) {
    const end = input.indexOf(PASTE_END);
    const body = input.slice(PASTE_START.length, end === -1 ? undefined : end);
    const used = end === -1 ? input.length : end + PASTE_END.length;
    return [{ type: "text", text: body.replace(/\r\n?/g, "\n") }, used];
  }
  if (input === "\x1b") return [{ type: "cancel" }, 1];
  if (input[1] === "\r") return [{ type: "newline" }, 2];
  const csi = input[1] === "[" || input[1] === "O" ? /^([\d;]*)([A-Za-z~])/.exec(input.slice(2)) : null;
  if (csi === null) return [undefined, 1];
  const [body, params = "", final = ""] = csi;
  const used = body.length + 2;
  const [first = "", second = "1"] = params.split(";");
  if (final === "u") return [kittyKey(Number(first), Number(second)), used];
  const type = final === "~" ? CSI_TILDE[first] : CSI_FINAL[final];
  return [type ? ({ type } as Key) : undefined, used];
}

const CONTROL: Record<string, Key["type"]> = {
  "\r": "submit",
  "\n": "newline",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "cancel",
  "\x04": "cancel",
};

export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] ?? "";
    if (char === "\x1b") {
      const [key, used] = escape(input.slice(i));
      if (key) keys.push(key);
      i += used;
    } else if (CONTROL[char]) {
      keys.push({ type: CONTROL[char] } as Key);
      i += 1;
    } else if (char < " " || char === "\x7f") {
      i += 1;
    } else {
      let end = i + 1;
      while (end < input.length && (input[end] ?? "") >= " " && input[end] !== "\x7f") end += 1;
      keys.push({ type: "text", text: input.slice(i, end) });
      i = end;
    }
  }
  return keys;
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const end = text.indexOf("\n", cursor);
  return end === -1 ? text.length : end;
}

// Moves to the same column on the line above or below, or to the line's end
// when that line is shorter.
function vertical(draft: Draft, direction: -1 | 1): number {
  const { text, cursor } = draft;
  const start = lineStart(text, cursor);
  const column = cursor - start;
  if (direction === -1) {
    if (start === 0) return 0;
    const above = lineStart(text, start - 1);
    return Math.min(above + column, start - 1);
  }
  const end = lineEnd(text, cursor);
  if (end === text.length) return text.length;
  return Math.min(end + 1 + column, lineEnd(text, end + 1));
}

function insert(draft: Draft, text: string): Draft {
  const { cursor } = draft;
  return { text: draft.text.slice(0, cursor) + text + draft.text.slice(cursor), cursor: cursor + text.length };
}

export function apply(draft: Draft, key: Key): Draft {
  const { text, cursor } = draft;
  switch (key.type) {
    case "text":
      return insert(draft, key.text);
    case "newline":
      return insert(draft, "\n");
    case "backspace":
      return cursor === 0 ? draft : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "left":
      return { text, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, cursor + 1) };
    case "up":
      return { text, cursor: vertical(draft, -1) };
    case "down":
      return { text, cursor: vertical(draft, 1) };
    case "home":
      return { text, cursor: lineStart(text, cursor) };
    case "end":
      return { text, cursor: lineEnd(text, cursor) };
    default:
      return draft;
  }
}

export interface View {
  rows: string[];
  row: number;
  column: number;
}

// Soft-wraps the draft to `width` columns and finds the cursor in the result.
export function view(draft: Draft, width: number): View {
  const rows: string[] = [];
  let row = 0;
  let column = 0;
  let offset = 0;
  for (const line of draft.text.split("\n")) {
    const pieces = line.length === 0 ? [""] : (line.match(new RegExp(`.{1,${width}}`, "g")) ?? [""]);
    pieces.forEach((piece, index) => {
      const start = offset + index * width;
      const last = index === pieces.length - 1;
      if (draft.cursor >= start && (draft.cursor < start + piece.length || (last && draft.cursor === start + piece.length))) {
        row = rows.length;
        column = draft.cursor - start;
      }
      rows.push(piece);
    });
    offset += line.length + 1;
  }
  return { rows, row, column };
}
