import { afterAll } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const templates = new Map<(root: string) => void, string>();

// A test worker exits without running exit handlers, so the templates go when
// the importing file finishes.
afterAll(() => {
  for (const template of templates.values()) rmSync(template, { recursive: true, force: true });
  templates.clear();
});

/**
 * Copy into `dest` the tree `build` writes under the root it is handed, running
 * `build` only on the first call in this process. A git fixture costs a dozen
 * spawns, and a per-test copy spawns nothing. Every git `config` in the copy
 * that names the template's root is rewritten to name `dest`, so a remote URL
 * points at the copy's own origin rather than the template's.
 */
export function copyFixture(build: (root: string) => void, dest: string): void {
  let template = templates.get(build);
  if (template === undefined) {
    template = mkdtempSync(join(tmpdir(), "fixture-"));
    build(template);
    templates.set(build, template);
  }
  cpSync(template, dest, { recursive: true });
  for (const entry of readdirSync(template, { recursive: true, withFileTypes: true })) {
    if (entry.name !== "config" || !entry.isFile()) continue;
    const path = join(dest, relative(template, entry.parentPath), entry.name);
    const text = readFileSync(path, "utf8");
    if (text.includes(template)) writeFileSync(path, text.replaceAll(template, dest));
  }
}
