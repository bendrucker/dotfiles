export type Checks = "passed" | "running" | "failed" | "no-ci" | "none";
export type Review = "changes_requested" | "pending" | "draft" | "approved";
export type Step = "review" | "go" | "wake" | "prune" | "collapsed";

/** The branch's open pull request, as Worktrunk reports it. */
export interface PrInfo {
  number: number;
  conflicting: boolean;
  checks: Checks;
  review?: Review;
}

export interface AgentInfo {
  paneId: string;
  status: string;
  blockedToken: boolean;
  doneToken: boolean;
  /** Set while the agent waits on a review from you, from the `$review` token. */
  review?: { kind?: string; summary?: string };
}

export interface DispositionInput {
  /** Worktrunk found the branch's content in the default branch. */
  integrated: boolean;
  /** The branch sits at the default branch's commit with nothing of its own. */
  empty: boolean;
  pr?: PrInfo;
  agents: AgentInfo[];
  dirty: boolean;
  unpushed: number;
  ignored: string[];
}

export interface Disposition {
  step: Step;
  reason: string;
  flags: string[];
  /** What the review is for, set only on a review. */
  detail?: string;
  /** The pane the step acts on. */
  pane?: string;
}

export function pruneFlags(input: DispositionInput): string[] {
  const flags: string[] = [];
  if (input.agents.some((agent) => agent.status === "working")) flags.push("live");
  if (input.dirty) flags.push("dirty");
  if (input.unpushed > 0) flags.push(`unpushed:${input.unpushed}`);
  if (input.ignored.length > 0) flags.push(`ignored:${input.ignored.length}`);
  return flags;
}

function idle(agent: AgentInfo): boolean {
  return agent.status !== "working" && agent.status !== "blocked" && !agent.blockedToken;
}

// Problems the agent can work on without you.
function fixable(pr: PrInfo | undefined): string | undefined {
  if (pr === undefined) return undefined;
  if (pr.checks === "failed") return "CI failing";
  if (pr.conflicting) return "conflicting";
  if (pr.review === "changes_requested") return "changes requested";
  return undefined;
}

function ready(pr: PrInfo | undefined): string | undefined {
  if (pr === undefined || pr.review === "draft") return undefined;
  if (pr.checks !== "passed" && pr.checks !== "no-ci") return undefined;
  return pr.review === "pending" ? "awaiting review" : "ready to merge";
}

function collapsedReason(input: DispositionInput): string {
  if (input.agents.some((agent) => agent.status === "working")) return "working";
  if (input.empty) return "no commits";
  if (input.pr === undefined) return "no PR";
  if (input.pr.review === "draft") return "draft";
  if (input.pr.checks === "running") return "checks running";
  return "open PR";
}

export function dispose(input: DispositionInput): Disposition {
  const { agents, pr } = input;

  const reviewing = agents.find((agent) => agent.review !== undefined);
  if (reviewing?.review) {
    return { step: "review", reason: reviewing.review.kind || "review", detail: reviewing.review.summary, flags: [], pane: reviewing.paneId };
  }

  if (input.integrated && pr === undefined) return { step: "prune", reason: "merged", flags: pruneFlags(input) };

  if (agents.some((agent) => agent.status === "blocked" || agent.blockedToken)) return { step: "go", reason: "blocked", flags: [] };
  const problem = fixable(pr);
  if (problem) {
    const waiting = agents.find(idle);
    if (waiting) return { step: "wake", reason: problem, flags: [], pane: waiting.paneId };
    if (agents.length === 0) return { step: "go", reason: problem, flags: [] };
  }

  if (agents.some((agent) => agent.doneToken)) return { step: "go", reason: "done", flags: [] };

  const merge = agents.some((agent) => agent.status === "working") ? undefined : ready(pr);
  if (merge) return { step: "go", reason: merge, flags: [] };

  return { step: "collapsed", reason: collapsedReason(input), flags: [] };
}
