import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deepestCovering, nestShell } from "#trace/containment";
import { parseEvents } from "#trace/events";
import type { Span } from "#trace/span";
import { buildTree, type Tree } from "#trace/tree";

/** What a file under sources/ exports: spans derived from one tool's own records. */
export type Collect = (dir: string, shell: Span[]) => Span[] | Promise<Span[]>;

const SOURCES = join(import.meta.dir, "sources");

export function sourceFiles(dir = SOURCES): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort()
    .map((file) => join(dir, file));
}

async function collectFrom(file: string, dir: string, shell: Span[]): Promise<Span[]> {
  const mod: unknown = await import(file);
  if (typeof mod !== "object" || mod === null || !("collect" in mod) || typeof mod.collect !== "function") {
    throw new Error(`${file} exports no collect function`);
  }
  const spans: unknown = await mod.collect(dir, shell);
  if (!Array.isArray(spans)) throw new Error(`${file} collect returned ${typeof spans}, not an array`);
  return spans as Span[];
}

/**
 * Read a trace directory into a tree. A tool span without a parent of its own
 * goes under the innermost shell span covering it.
 */
export async function loadTrace(dir: string, sources = sourceFiles()): Promise<Tree> {
  const events = join(dir, "events.tsv");
  if (!existsSync(events)) throw new Error(`no events.tsv in ${dir}`);
  const shell = parseEvents(readFileSync(events, "utf8"));
  nestShell(shell);

  const derived: Span[] = [];
  for (const file of sources) {
    for (const span of await collectFrom(file, dir, shell)) {
      span.parent ??= deepestCovering(shell, span.start, span.end);
      derived.push(span);
    }
  }
  return buildTree([...shell, ...derived]);
}
