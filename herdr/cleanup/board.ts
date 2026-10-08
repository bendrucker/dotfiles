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

// Three header lines, then one line per actionable row as `<key>\t<display>`.
// The header has an empty key so `--with-nth=2..` still shows it.
// fzf shows the display and hands the key back to whichever action runs.
export function render(local: Row[], remote: Row[] | undefined, showRemote: boolean, now: number): string[] {
  const rows = [...local, ...(remote ?? [])];
  const shown = rows.filter((row) => row.step !== "collapsed");
  const sum = summarize(rows);
  const freshness = [`forge ${age(summarize(local).oldestFetch, now)}`, "herdr live"];
  if (showRemote) freshness.push(remote === undefined ? `${MACHINE} unreachable` : `${MACHINE} ${age(summarize(remote).oldestFetch, now)}`);

  const table = alignColumns(
    // The step leads so a narrow overlay truncates the reason rather than the step.
    shown.map((row) => [
      `→ ${row.step}`,
      `${row.machine ? `${row.machine}:` : ""}${row.label}`,
      row.pr?.ref ?? "",
      [row.reason, ...row.flags].join(" · "),
    ]),
  );
  return [
    `\tcleanup · ${sum.needYou} need you · ${sum.finish} safe to finish · ${sum.collapsed} collapsed`,
    `\t${freshness.join(" · ")}`,
    `\tenter go · p prune · x close · w wake · r refresh · m ${MACHINE} · q quit`,
    ...shown.map((row, i) => `${key(row)}\t${table[i]}`),
  ];
}
