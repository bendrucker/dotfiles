import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "./reviewer";

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

// The commented lines from the working tree, or from HEAD for the old side.
export function quoter(cwd: string): (comment: Comment) => string | undefined {
  return (comment) => {
    const { path, startLine } = comment;
    if (path === undefined || startLine === undefined) return undefined;
    const end = comment.endLine ?? startLine;
    const file = fileLines(cwd, path, comment.side ?? "new");
    if (file === undefined) return undefined;
    return Array.from({ length: end - startLine + 1 }, (_, i) => `> ${file[startLine + i - 1] ?? ""}`).join("\n");
  };
}
