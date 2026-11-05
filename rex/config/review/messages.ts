import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment } from "./reviewer";

const HUMAN = "Ben";

function location(comment: Comment): string {
  if (comment.path === undefined) return "the review";
  if (comment.startLine === undefined) return comment.path;
  const end = comment.endLine ?? comment.startLine;
  return end === comment.startLine ? `${comment.path}:${end}` : `${comment.path}:${comment.startLine}-${end}`;
}

// The commented lines as they read in the working tree. Old-side lines are gone from it.
function quote(comment: Comment, cwd: string): string | undefined {
  if (comment.path === undefined || comment.startLine === undefined || comment.side === "old") return undefined;
  let text: string;
  try {
    text = readFileSync(join(cwd, comment.path), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").slice(comment.startLine - 1, comment.endLine ?? comment.startLine);
  return lines.map((line) => `> ${line}`).join("\n");
}

export function changes(comments: Comment[], cwd: string): string {
  const count = comments.length === 1 ? "1 comment" : `${comments.length} comments`;
  const blocks = comments.map((c) =>
    [`## ${location(c)} (id ${c.id})`, quote(c, cwd), c.body].filter((part) => part !== undefined).join("\n"),
  );
  return [
    `[review: changes] ${HUMAN} left ${count} on your changes.`,
    ...blocks,
    `Fix each one, then answer it with \`rex do review_reply id=<id> text="<reply>"\`. Don't commit. End your turn when every comment has an answer, and ${HUMAN} will see the review again.`,
  ].join("\n\n");
}

export const approved = `[review: approved] ${HUMAN} approved the changes. Continue.`;

export const dismissed = `[review: dismissed] ${HUMAN} closed the review without feedback. Treat this as a successful outcome and continue.`;

export function failed(code: number): string {
  return `[review: failed] The reviewer exited with status ${code} before ${HUMAN} finished. Tell ${HUMAN} and wait.`;
}
