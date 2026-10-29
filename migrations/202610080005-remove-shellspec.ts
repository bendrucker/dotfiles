// EXPIRES: 2027-04-08 every machine has run scripts/install since the removal

import { removeFormula } from "#migrations/migration";

export async function up(): Promise<void> {
  await removeFormula("shellspec");
}
