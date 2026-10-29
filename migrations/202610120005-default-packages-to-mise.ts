// The default-package lists moved to mise [tools]. An `npm i -g` copy sits in
// node's own bin, which mise puts ahead of the npm: tools, so a stale global
// tsc would win. Both lists go too, since mise reads them to seed every node
// and go version it installs.
//
// The go copies in $GOBIN stay: mise's paths come first, and editors that look
// in $GOBIN for dlv still find one.
//
// EXPIRES: 2027-04-12 every machine has run scripts/install since the move

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Context, contains, isEmpty, linkTarget, missing, nodeInstalls, removeTree } from "#migrations/migration";

const PACKAGES = ["@modelcontextprotocol/inspector", "ccusage", "typescript", "typescript-language-server"];

// The first line bin/build-default-packages wrote. A list someone wrote by
// hand is left alone.
const GENERATED = "# Auto-generated from dotfiles";

export async function up(context: Context): Promise<void> {
  for (const name of [".default-npm-packages", ".default-go-packages"]) {
    const list = join(context.home, name);
    if (generated(list)) await removeTree(context, list);
  }

  for (const install of nodeInstalls(context)) await removePackages(context, install);
}

function generated(path: string): boolean {
  try {
    return readFileSync(path, "utf8").startsWith(GENERATED);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

// What `npm uninstall -g` would remove, done directly so it doesn't depend on
// that version's node still running. Other entries in bin are someone's own.
async function removePackages(context: Context, install: string): Promise<void> {
  const modules = join(install, "lib", "node_modules");
  const pkgs = PACKAGES.map((name) => join(modules, name));
  const bin = join(install, "bin");

  for (const entry of entries(bin)) {
    const target = linkTarget(join(bin, entry));
    if (target !== undefined && pkgs.some((pkg) => contains(pkg, target))) await removeTree(context, join(bin, entry));
  }

  for (const pkg of pkgs) {
    await removeTree(context, pkg);
    const scope = dirname(pkg);
    if (scope !== modules && isEmpty(scope)) await removeTree(context, scope);
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
