// awscli and golangci-lint moved from Homebrew to pins in aws/mise.toml and
// go/mise.toml, so the Homebrew copies would keep upgrading every night beside
// them. scripts/install aborts on a failed `mise install`, which runs before
// this, so each pinned tool is on disk before its Homebrew copy goes.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move to mise

import { type Context, removeFormula } from "#migrations/migration";

export const FORMULAE = ["awscli", "golangci-lint"];

export function up(context: Context): void {
  for (const name of FORMULAE) removeFormula(context, name);
}
