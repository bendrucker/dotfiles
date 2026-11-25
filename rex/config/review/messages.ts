import type { Event } from "./delivery";
import type { Comment } from "./reviewer";
import type { Review } from "./state";

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

type Target = Pick<Review, "doc" | "revisions">;

// A review's document path, or the diff, keys it within its agent.
export function subject({ doc, revisions }: Target): string {
  return doc ?? (revisions === undefined ? "diff" : `diff ${revisions}`);
}

function described(review: Target): string {
  if (review.doc !== undefined) return review.doc;
  return review.revisions === undefined ? "the diff" : `the diff of ${review.revisions}`;
}

// The closed line is the events file's last, which tells the watcher to stop.
// An ended line marks one review of several, and the watcher keeps reading.
export function ended(outcome: string, review: Target, othersOpen: boolean): string {
  return othersOpen ? `[review: ended] ${outcome} ${review.doc ?? "diff"}` : `[review: closed] ${outcome}`;
}

// Says which review an outcome covers while another is still open.
export function scoped(message: string, review: Target, others: Target[]): string {
  if (others.length === 0) return message;
  const open = others.map(described).join(" and ");
  return `${message}\n\nThis covers only the review of ${described(review)}. The review of ${open} is still open, so wait for its outcome before you treat the work as approved.`;
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
