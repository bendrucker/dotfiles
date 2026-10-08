export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type Checks = "ok" | "fail" | "pending" | "none";
export type Step = "prune" | "go" | "wake" | "collapsed";

export interface PrInfo {
  number: number;
  state: PrState;
  draft: boolean;
  conflicting: boolean;
  checks: Checks;
  updated: string;
  /** The commit the forge holds for the branch. */
  head?: string;
}

export interface AgentInfo {
  paneId: string;
  status: string;
  blockedToken: boolean;
  doneToken: boolean;
}

export interface DispositionInput {
  prs: PrInfo[];
  agents: AgentInfo[];
  /** Last time each pane was seen working, in ms since the epoch. */
  lastWorked: Record<string, number>;
  dirty: boolean;
  unpushed: number;
  ignored: string[];
}

export interface Disposition {
  step: Step;
  reason: string;
  flags: string[];
  /** The pane to wake, set only on a wake. */
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

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function pruneReason(prs: PrInfo[]): string | undefined {
  if (prs.length === 0 || prs.some((pr) => pr.state === "OPEN")) return undefined;
  if (prs.some((pr) => pr.state === "MERGED")) return "merged";
  const newest = prs.reduce((a, b) => (time(b.updated) > time(a.updated) ? b : a));
  return newest.state === "CLOSED" ? "closed" : undefined;
}

function goReason(input: DispositionInput, open: PrInfo[]): string | undefined {
  const { agents } = input;
  const working = agents.some((agent) => agent.status === "working");
  if (agents.some((agent) => agent.status === "blocked" || agent.blockedToken)) return "blocked";
  if (open.some((pr) => pr.checks === "fail")) return "CI failing";
  if (open.some((pr) => pr.conflicting)) return "conflicting";
  if (agents.some((agent) => agent.doneToken)) return "done, review";
  if (!working && open.some((pr) => !pr.draft && pr.checks === "ok")) return "ready to merge";
  return undefined;
}

function wakePane(input: DispositionInput, open: PrInfo[]): string | undefined {
  const newest = Math.max(0, ...open.map((pr) => time(pr.updated)));
  return input.agents.find((agent) => {
    if (agent.status === "working" || agent.status === "blocked") return false;
    const worked = input.lastWorked[agent.paneId];
    return worked !== undefined && newest > worked;
  })?.paneId;
}

function collapsedReason(input: DispositionInput, open: PrInfo[]): string {
  if (input.agents.some((agent) => agent.status === "working")) return "working";
  if (input.prs.length === 0) return "no PR";
  if (open.length > 0 && open.every((pr) => pr.draft)) return "draft";
  if (open.some((pr) => pr.checks === "pending")) return "checks pending";
  return "open PR";
}

export function dispose(input: DispositionInput): Disposition {
  const merged = pruneReason(input.prs);
  if (merged) return { step: "prune", reason: merged, flags: pruneFlags(input) };

  const open = input.prs.filter((pr) => pr.state === "OPEN");

  const go = goReason(input, open);
  if (go) return { step: "go", reason: go, flags: [] };

  const pane = wakePane(input, open);
  if (pane) return { step: "wake", reason: "PR updated since agent idled", flags: [], pane };

  return { step: "collapsed", reason: collapsedReason(input, open), flags: [] };
}
