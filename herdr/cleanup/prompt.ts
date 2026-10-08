import { apply, parseKeys, view, type Draft } from "./editor";

const HEIGHT = 6;
const GUTTER = "\x1b[35m┃\x1b[0m";
const KITTY_ON = "\x1b[>1u";
const KITTY_OFF = "\x1b[<u";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const CLEAR = "\x1b[H\x1b[J";

function hint(key: string, action: string): string {
  return `\x1b[1;34m${key}\x1b[0m \x1b[2m${action}\x1b[0m`;
}

const HELP = [hint("enter", "send"), hint("shift+enter", "new line"), hint("esc", "cancel")].join("\x1b[2m · \x1b[0m");

// The whole screen for one state of the draft, ending with the terminal cursor
// placed where the next character goes.
export function frame(draft: Draft, title: string, columns: number): string {
  const { rows, row, column } = view(draft, Math.max(20, columns - 4));
  const top = Math.max(0, row - HEIGHT + 1);
  const shown = rows.slice(top, top + HEIGHT);
  while (shown.length < HEIGHT) shown.push("");
  const body = shown.map((line) => `${GUTTER} ${line}`);
  const screen = [`\x1b[1m${title}\x1b[0m`, "", ...body, "", HELP].join("\r\n");
  return `${CLEAR}${screen}\x1b[${row - top + 3};${column + 3}H`;
}

// Resolves to the text to send, or undefined when the user cancels.
export async function edit(initial: string, title: string): Promise<string | undefined> {
  const { stdin, stderr } = process;
  let draft: Draft = { text: initial, cursor: initial.length };
  stdin.setRawMode?.(true);
  stderr.write(KITTY_ON + PASTE_ON);
  const draw = () => stderr.write(frame(draft, title, stderr.columns ?? 80));
  draw();
  try {
    for await (const chunk of stdin) {
      for (const key of parseKeys(String(chunk))) {
        if (key.type === "submit") return draft.text;
        if (key.type === "cancel") return undefined;
        draft = apply(draft, key);
      }
      draw();
    }
    return undefined;
  } finally {
    stderr.write(KITTY_OFF + PASTE_OFF + CLEAR);
    stdin.setRawMode?.(false);
  }
}
