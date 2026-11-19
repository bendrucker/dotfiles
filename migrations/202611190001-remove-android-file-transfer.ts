// Google discontinued Android File Transfer in 2024.
//
// EXPIRES: 2027-05-19 every machine has run scripts/install since the root Brewfile dropped it

import { removeCask } from "#migrations/migration";

export const platform = "darwin";

export async function up(): Promise<void> {
  await removeCask("android-file-transfer");
}
