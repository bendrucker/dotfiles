// The tests moved from shellspec to bun, which stopped declaring the formula
// without uninstalling it, so it surfaces every night through scripts/brew-drift.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { type Context, removeFormula } from "#migrations/migration";

export function up(context: Context): void {
  removeFormula(context, "shellspec");
}
