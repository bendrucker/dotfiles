import { alignColumns } from "#worktree/table";
import { summarize, type Row } from "./rows";

export const MACHINE = "work";

export function age(iso: string | undefined, now: number): string {
  if (iso === undefined) return "never";
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function key(row: Row): string {
  return `${row.machine ?? "local"}:${row.workspaceId}`;
}

// SGR codes from the terminal's 16-color palette, so the theme picks the hues.
const RESET = "\x1b[0m";
const paint = (code: string, text: string): string => (text ? `\x1b[${code}m${text}${RESET}` : text);
const dim = (text: string): string => paint("2", text);
const DOT = dim(" · ");

const STEP_COLOR: Record<string, string> = { go: "1;31", wake: "1;33", prune: "1;32" };

const REASON_COLOR: Record<string, string> = {
  blocked: "31",
  "CI failing": "31",
  conflicting: "31",
  "ready to merge": "32",
  "done, review": "36",
  "PR updated since agent idled": "33",
  merged: "35",
  closed: "2",
};

function flagColor(flag: string): string {
  if (flag === "live" || flag === "unreadable") return "31";
  if (flag.startsWith("ignored")) return "2";
  return "33";
}

function cells(row: Row): string[] {
  const machine = row.machine ? paint("2;36", `${row.machine}:`) : "";
  return [
    paint(STEP_COLOR[row.step] ?? "1", `→ ${row.step}`),
    `${machine}${paint("1", row.label)}`,
    paint("34", row.pr?.ref ?? ""),
    [paint(REASON_COLOR[row.reason] ?? "0", row.reason), ...row.flags.map((flag) => paint(flagColor(flag), flag))].join(DOT),
  ];
}

const keyHint = (keys: string, action: string): string => `${paint("1;34", keys)} ${dim(action)}`;

// Three header lines, then one line per actionable row as `<key>\t<display>`.
// The header has an empty key so `--with-nth=2..` still shows it.
export function render(local: Row[] | undefined, remote: Row[] | undefined, showRemote: boolean, now: number): string[] {
  const rows = [...(local ?? []), ...(remote ?? [])];
  const shown = rows.filter((row) => row.step !== "collapsed");
  const sum = summarize(rows);
  const unreachable = (what: string): string => paint("31", `${what} unreachable`);
  const freshness = [dim(`forge ${age(summarize(local ?? []).oldestFetch, now)}`), local === undefined ? unreachable("herdr") : dim("herdr live")];
  if (showRemote) freshness.push(remote === undefined ? unreachable(MACHINE) : dim(`${MACHINE} ${age(summarize(remote).oldestFetch, now)}`));

  const counts = [
    `${paint("1;31", String(sum.needYou))} need you`,
    `${paint("1;32", String(sum.finish))} safe to finish`,
    dim(`${sum.collapsed} collapsed`),
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
    `\t${freshness.join(DOT)}`,
    `\t${keys.join(DOT)}`,
    ...shown.map((row, i) => `${key(row)}\t${table[i]}`),
  ];
}
