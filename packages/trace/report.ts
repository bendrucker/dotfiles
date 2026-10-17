import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nestShell } from "#trace/containment";
import { parseEvents } from "#trace/events";
import { buildTree, type Tree } from "#trace/tree";

/** Read a trace directory's shell spans into a tree. */
export function loadTrace(dir: string): Tree {
  const events = join(dir, "events.tsv");
  if (!existsSync(events)) throw new Error(`no events.tsv in ${dir}`);
  const shell = parseEvents(readFileSync(events, "utf8"));
  nestShell(shell);
  return buildTree(shell);
}
