import type { Event } from "./delivery";
import type { Comment } from "./reviewer";

const HUMAN = "Ben";

function location(comment: Comment): string {
  if (comment.path === undefined) return "the review";
  if (comment.startLine === undefined) return comment.path;
  const end = comment.endLine ?? comment.startLine;
  return end === comment.startLine ? `${comment.path}:${end}` : `${comment.path}:${comment.startLine}-${end}`;
}

function heading(event: Event): string {
  if (event.kind === "retracted") return `[review: retracted] (id ${event.id})`;
  const where = `${location(event.comment)} (id ${event.comment.id})`;
  return event.kind === "edited" ? `[review: comment edited] ${where}` : where;
}

function parts(event: Event): string[] {
  if (event.kind === "retracted") return [`${HUMAN} deleted this comment. Drop it.`];
  const reply = event.context === undefined ? undefined : `In reply to your note: ${event.context}`;
  return [event.quote, reply, event.comment.body].filter((part) => part !== undefined);
}

function blocks(events: Event[]): string[] {
  return events.map((event) => [`## ${heading(event)}`, ...parts(event)].join("\n"));
}

function count(events: Event[]): string {
  return events.length === 1 ? "1 comment" : `${events.length} comments`;
}

export function changes(events: Event[]): string {
  return [
    `[review: changes] ${HUMAN} left ${count(events)} on your changes.`,
    ...blocks(events),
    `Fix each one, then answer it with JSON on stdin:\n\n\`\`\`sh\nrex do review_reply --args - <<'EOF'\n{"id": "<id>", "text": "<reply>"}\nEOF\n\`\`\`\n\nDon't commit. End your turn when every comment has an answer, and ${HUMAN} will see the review again.`,
  ].join("\n\n");
}

function flat(text: string): string {
  return text.replaceAll("\n", " ⏎ ");
}

// One line per note, because each line of a watcher's stdout is one event.
export function live(event: Event): string {
  const head = event.kind === "edited" || event.kind === "retracted" ? heading(event) : `[review: comment] ${heading(event)}`;
  return [head, ...parts(event)].map(flat).join(" | ");
}

// The last line of the events file, which tells the watcher to stop.
export function ended(outcome: string): string {
  return `[review: closed] ${outcome}`;
}

export function approved(events: Event[] = []): string {
  if (events.length === 0) return `[review: approved] ${HUMAN} approved the changes. Continue.`;
  return [
    `[review: approved] ${HUMAN} approved the changes, once you address the ${count(events)} below.`,
    ...blocks(events),
    `The review is closed, so fix each one without replying, then continue.`,
  ].join("\n\n");
}

// Hunk quit without Approve. The review is closed, so replies can't reach it.
export function closed(events: Event[], unanswered: string[]): string {
  const pending = unanswered.length === 0 ? [] : [`These earlier comments have no reply yet: ${unanswered.map((id) => `id ${id}`).join(", ")}.`];
  return [
    `[review: closed] ${HUMAN} closed Hunk without approving.`,
    ...blocks(events),
    ...pending,
    `Address each comment, then ask ${HUMAN} how to proceed. Don't commit.`,
  ].join("\n\n");
}

export function dismissed(feedback: boolean): string {
  return feedback
    ? `[review: dismissed] ${HUMAN} dismissed the review. Treat this as a successful outcome and continue.`
    : `[review: dismissed] ${HUMAN} closed the review without feedback. Treat this as a successful outcome and continue.`;
}

export function failed(code: number): string {
  return `[review: failed] The reviewer exited with status ${code} before ${HUMAN} finished. Tell ${HUMAN} and wait.`;
}
