import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "./reviewer";

interface Sides {
  old: Map<number, string>;
  new: Map<number, string>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Numbers each line a unified diff shows by its line on the old and new side.
export function sides(patch: string): Sides {
  const result: Sides = { old: new Map(), new: new Map() };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("-")) {
      result.old.set(oldLine++, line.slice(1));
    } else if (line.startsWith("+")) {
      result.new.set(newLine++, line.slice(1));
    } else if (line.startsWith(" ")) {
      result.old.set(oldLine++, line.slice(1));
      result.new.set(newLine++, line.slice(1));
    }
  }
  return result;
}

export function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function fileLines(cwd: string, path: string, side: "old" | "new"): string[] | undefined {
  if (side === "new") {
    try {
      return readFileSync(join(cwd, path), "utf8").split("\n");
    } catch {
      return undefined;
    }
  }
  const shown = Bun.spawnSync(["git", "show", `HEAD:${path}`], { cwd, stdout: "pipe", stderr: "ignore" });
  return shown.exitCode === 0 ? shown.stdout.toString().split("\n") : undefined;
}

// The commented lines as the reviewer's diff shows them. Lines outside it come
// from the working tree, or from HEAD for the old side.
export function quoter(cwd: string, patches: Record<string, string> = {}): (comment: Comment) => string | undefined {
  const parsed = new Map<string, Sides>();
  return (comment) => {
    const { path, startLine } = comment;
    if (path === undefined || startLine === undefined) return undefined;
    const side = comment.side ?? "new";
    const end = comment.endLine ?? startLine;
    const numbers = Array.from({ length: end - startLine + 1 }, (_, i) => startLine + i);

    const patch = patches[path];
    if (patch !== undefined && !parsed.has(path)) parsed.set(path, sides(patch));
    const shown = parsed.get(path)?.[side];
    let lines: (string | undefined)[] = numbers.map((n) => shown?.get(n));
    if (lines.some((line) => line === undefined)) {
      const file = fileLines(cwd, path, side);
      if (file === undefined) return undefined;
      lines = numbers.map((n) => file[n - 1]);
    }
    return lines.map((line) => `> ${line ?? ""}`).join("\n");
  };
}
