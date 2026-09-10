// Two retired apps the Brewfile stopped declaring in the same commit.
//
// UTC Bar ships an Intel-only binary and is abandoned upstream. macOS 27 is the
// last release carrying Rosetta, so it stops running at the next one either
// way. Ice covers the menu bar now, and the Brewfile already installs it.
// Dictation moved from Wispr Flow to Raycast.
//
// EXPIRES: 2027-03-10 every machine has run scripts/install since the removal

import { rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "#jobs/output";
import { type Context, exists, removeCask } from "#migrations/migration";

export const platform = "darwin";

// The bundle goes first because removeCask throws on a nonzero uninstall, and a
// throw leaves the stamp where it was and stops the migrations behind this one.
// Ordering the cleanup that cannot throw ahead of it keeps one flaky brew run
// from holding the other back for a night.
export function up(context: Context): void {
  removeApplication(context, "UTC Bar.app");
  removeCask(context, "wispr-flow");
}

// `mas uninstall` needs root, so the bundle goes directly. An App Store install
// is root:wheel with no write bit for anyone else, and removing it means
// unlinking the files inside the bundle rather than only the bundle itself, so
// this normally cannot succeed as the user and says so instead. Escalating is
// what a migration running unattended at 3am must not do, and the leftover is
// harmless until it is dealt with awake.
function removeApplication(context: Context, name: string): void {
  const app = join(context.applications, name);
  if (!exists(app)) return;

  try {
    rmSync(app, { recursive: true, force: true });
    log(context.out, "info", `removed ${app}`);
  } catch (error) {
    if (!denied(error)) throw error;
    log(context.out, "warn", `${app} needs root to remove: sudo rm -rf ${quote(app)}`);
  }
}

// The path is going into a line someone pastes into a shell, and this one holds
// a space. Single quotes rather than double, which would still take a `$(…)` in
// a name as something to run.
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function denied(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EPERM";
}
