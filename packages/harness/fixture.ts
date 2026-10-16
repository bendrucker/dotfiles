import { afterAll } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

type Template = { root: string; configs: string[] };

function buildTemplate(build: (root: string) => void): Template {
  const root = mkdtempSync(join(tmpdir(), "fixture-"));
  try {
    build(root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const configs = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name === "config" && entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => readFileSync(join(root, path), "utf8").includes(root));
  return { root, configs };
}

/**
 * Return a function that copies into `dest` the tree `build` writes under the
 * root it is handed, running `build` only on the first copy. Every git `config`
 * in the copy that names the template's root is rewritten to name `dest`, so a
 * remote URL points at the copy's own origin.
 *
 * Call it at the top level of a test file. That registers the template's
 * removal with that file, which a bare `bun test` sharing one module registry
 * across files would otherwise give to whichever file imported this first.
 */
export function fixture(build: (root: string) => void): (dest: string) => void {
  let template: Template | undefined;
  afterAll(() => {
    if (template) rmSync(template.root, { recursive: true, force: true });
    template = undefined;
  });
  return (dest) => {
    template ??= buildTemplate(build);
    cpSync(template.root, dest, { recursive: true });
    for (const config of template.configs) {
      const path = join(dest, config);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(template.root, dest));
    }
  };
}
