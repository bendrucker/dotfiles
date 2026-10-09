// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { type Context, removeFormula } from "#migrations/migration";

export function up(context: Context): void {
  removeFormula(context, "shellspec");
}
