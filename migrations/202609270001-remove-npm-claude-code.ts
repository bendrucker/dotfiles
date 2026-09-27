// Claude Code comes from the `claude-code@latest` cask in claude/Brewfile. An
// older `npm i -g @anthropic-ai/claude-code` into a mise node left a `claude`
// in that install's bin, and mise shims every bin of every installed version,
// active or not. The shim sits ahead of Homebrew on PATH, so every `claude`
// call spends ~300 ms in mise resolving it, finding the version inactive, and
// falling through to the cask's binary.
//
// Only the package goes, not the node version holding it. Nothing in this repo
// declares that version, but a project on some machine may still pin it.
//
// EXPIRES: 2027-03-27 every machine has run scripts/install since the removal

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "#jobs/output";
import { type Context, contains, exists, isEmpty, linkTarget, removeTree } from "#migrations/migration";

export function up(context: Context): void {
  const mise = join(context.data, "mise");
  for (const install of nodeInstalls(mise)) removePackage(context, install);
  reshim(context, mise);
}

// Real directories only. mise also keeps aliases like `20` and `lts-iron` as
// symlinks to them, and walking those would visit each install twice.
function nodeInstalls(mise: string): string[] {
  const root = join(mise, "installs", "node");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

// What `npm uninstall -g` would remove, done directly so it doesn't depend on
// that version's node still running.
function removePackage(context: Context, install: string): void {
  const scope = join(install, "lib", "node_modules", "@anthropic-ai");
  const pkg = join(scope, "claude-code");
  if (!exists(pkg)) return;

  // Only the link npm made. A `claude` pointing anywhere else is someone's own.
  const bin = join(install, "bin", "claude");
  const target = linkTarget(bin);
  if (target !== undefined && contains(pkg, target)) removeTree(context, bin);

  removeTree(context, pkg);
  if (isEmpty(scope)) removeTree(context, scope);
}

// Keyed on the shim rather than on having removed something, so a reshim that
// fails tonight is retried after the package is already gone. When no other
// install provides `claude`, reshim deletes the shim.
function reshim(context: Context, mise: string): void {
  if (!exists(join(mise, "shims", "claude"))) return;

  const bin = Bun.which("mise", { PATH: process.env.PATH });
  if (bin === null) return;

  log(context.out, "info", "reshimming mise");
  if (context.out.run([bin, "reshim"], { stdin: "ignore" }) !== 0) {
    throw new Error("mise reshim failed");
  }
}
