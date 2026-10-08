// The CLI tools this repo's scripts call moved from Homebrew to the pins in
// system/mise.toml. Left installed, the Homebrew copy keeps upgrading every
// night and is what a process without mise on its PATH still finds.
//
// scripts/install aborts on a failed `mise install`, which runs before this, so
// every pinned tool is on disk by the time its Homebrew copy goes.
//
// EXPIRES: 2027-04-08 every machine has run scripts/install since the move to mise

import { log } from "#jobs/output";
import { type Context, removeFormula } from "#migrations/migration";

// actionlint before shellcheck, which the Homebrew actionlint depends on.
export const FORMULAE = [
  "actionlint",
  "ast-grep",
  "duckdb",
  "fd",
  "gitleaks",
  "hyperfine",
  "jq",
  "prek",
  "ripgrep",
  "shellcheck",
  "yq",
];

export function up(context: Context): void {
  for (const name of FORMULAE) {
    // brew refuses while another installed formula depends on this one, and
    // that formula is a reason to keep it rather than a reason to retry nightly.
    try {
      removeFormula(context, name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(context.out, "warn", `kept ${name}: ${reason}`);
    }
  }
}
