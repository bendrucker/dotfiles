import { alignColumns } from "#worktree/table";
import { summarize, type Row } from "./rows";

export const MACHINE = "work";

export function key(row: Row): string {
  return `${row.machine ?? "local"}:${row.workspaceId}`;
}

// SGR codes from the terminal's 16-color palette, so the theme picks the hues.
const RESET = "\x1b[0m";
const paint = (code: string, text: string): string => (text ? `\x1b[${code}m${text}${RESET}` : text);
const dim = (text: string): string => paint("2", text);
const DOT = dim(" · ");

const STEP_COLOR: Record<string, string> = { review: "1;36", go: "1;31", wake: "1;33", prune: "1;32" };

const REASON_COLOR: Record<string, string> = {
  blocked: "31",
  "CI failing": "31",
  conflicting: "31",
  "changes requested": "33",
  "ready to merge": "32",
  "awaiting review": "36",
  done: "36",
  merged: "35",
  "wt failed": "31",
  "not in wt list": "31",
};

function flagColor(flag: string): string {
  if (flag === "live" || flag === "unreadable") return "31";
  if (flag.startsWith("ignored")) return "2";
  return "33";
}

function reasonColor(row: Row): string {
  return row.step === "review" ? "1;36" : (REASON_COLOR[row.reason] ?? "0");
}

function cells(row: Row): string[] {
  const machine = row.machine ? paint("2;36", `${row.machine}:`) : "";
  const detail = row.detail ? [row.detail] : [];
  return [
    paint(STEP_COLOR[row.step] ?? "1", `→ ${row.step}`),
    `${machine}${paint("1", row.label)}`,
    paint("34", row.pr?.ref ?? ""),
    [paint(reasonColor(row), row.reason), ...detail, ...row.flags.map((flag) => paint(flagColor(flag), flag))].join(DOT),
  ];
}

const keyHint = (keys: string, action: string): string => `${paint("1;34", keys)} ${dim(action)}`;

export const HEADER_LINES = 2;

// The header lines, then one line per actionable row as `<key>\t<display>`.
// The header has an empty key so `--with-nth=2..` still shows it.
export function render(local: Row[] | undefined, remote: Row[] | undefined, showRemote: boolean): string[] {
  const rows = [...(local ?? []), ...(remote ?? [])];
  const shown = rows.filter((row) => row.step !== "collapsed");
  const sum = summarize(rows);
  const unreachable = (what: string): string => paint("31", `${what} unreachable`);
  const remoteState = remote === undefined ? unreachable(MACHINE) : dim(`with ${MACHINE}`);
  const down = [local === undefined ? unreachable("herdr") : "", showRemote ? remoteState : ""];

  const counts = [
    `${paint("1;31", String(sum.needYou))} need you`,
    `${paint("1;32", String(sum.finish))} safe to finish`,
    dim(`${sum.collapsed} collapsed`),
    ...down.filter(Boolean),
  ];
  const keys = [
    keyHint("enter", "go"),
    keyHint("p", "prune"),
    keyHint("x", "close"),
    keyHint("w", "wake"),
    keyHint("r", "refresh"),
    keyHint("m", MACHINE),
    keyHint("q", "quit"),
  ];
  // The step leads so a narrow overlay truncates the reason rather than the step.
  const table = alignColumns(shown.map(cells));
  return [
    `\t${[paint("1;35", "cleanup"), ...counts].join(DOT)}`,
    `\t${keys.join(DOT)}`,
    ...shown.map((row, i) => `${key(row)}\t${table[i]}`),
  ];
}
