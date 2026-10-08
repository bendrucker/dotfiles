import { dispose, type AgentInfo, type Checks, type PrInfo, type Review, type Step } from "./disposition";

export type Forge = "github" | "gitlab";

export interface Row {
  workspaceId: string;
  label: string;
  path: string;
  repoRoot: string;
  repoName: string;
  branch: string;
  /** The commit Worktrunk judged, so a removal can tell what landed since. */
  head?: string;
  forge: Forge | undefined;
  pr?: { number: number; ref: string };
  /** An agent in the workspace is working, which any removal has to ask about. */
  live?: boolean;
  agentPane?: string;
  step: Step;
  reason: string;
  detail?: string;
  flags: string[];
  ignored: string[];
  machine?: string;
}

/** One repo's `wt list --format=json`, or undefined when wt failed there. */
export type WtLists = Record<string, unknown>;

export interface Sources {
  snapshot: unknown;
  wt: WtLists;
  ignored: (path: string) => string[];
}

interface Workspace {
  id: string;
  label: string;
  path: string;
  repoRoot: string;
  repoName: string;
}

interface Worktree {
  branch: string;
  head?: string;
  integrated: boolean;
  empty: boolean;
  dirty: boolean;
  unpushed: number;
  pr?: PrInfo;
}

interface RepoList {
  forge: Forge | undefined;
  worktrees: Map<string, Worktree>;
}

const CHECKS: readonly string[] = ["passed", "running", "failed", "no-ci"];
const REVIEWS: readonly string[] = ["changes_requested", "pending", "draft", "approved"];
const STEP_ORDER: Step[] = ["review", "go", "wake", "prune", "collapsed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isChecks(value: unknown): value is Checks {
  return typeof value === "string" && CHECKS.includes(value);
}

function isReview(value: unknown): value is Review {
  return typeof value === "string" && REVIEWS.includes(value);
}

function checksOf(value: unknown): Checks {
  const status = isRecord(value) ? value.status : undefined;
  return isChecks(status) ? status : "none";
}

function parseWorktree(item: Record<string, unknown>): Worktree {
  const head = isRecord(item.head) ? text(item.head.sha) : "";
  const changes = isRecord(item.worktree) && isRecord(item.worktree.changes) ? item.worktree.changes : {};
  const state = isRecord(item.display) ? text(item.display.state) : "";
  const fromDefault = isRecord(item.default_branch) ? item.default_branch : {};
  const ahead = isRecord(item.upstream) ? item.upstream.ahead : undefined;
  const pr = isRecord(item.pr) ? item.pr : {};
  return {
    branch: text(item.branch),
    ...(head ? { head } : {}),
    integrated: state === "integrated",
    empty: state === "empty",
    dirty: ["staged", "modified", "untracked", "renamed", "deleted", "conflicted"].some((kind) => changes[kind] === true),
    unpushed: typeof ahead === "number" ? ahead : 0,
    ...(typeof pr.number === "number" && {
      pr: {
        number: pr.number,
        conflicting: pr.mergeable === false || fromDefault.merge_conflicts === true,
        checks: checksOf(item.checks),
        ...(isReview(pr.review) && { review: pr.review }),
      },
    }),
  };
}

function parseList(value: unknown): RepoList | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  const provider = isRecord(value.repo) && isRecord(value.repo.forge) ? text(value.repo.forge.provider) : "";
  const worktrees = new Map<string, Worktree>();
  for (const item of value.items) {
    if (!isRecord(item) || !isRecord(item.worktree)) continue;
    const path = text(item.worktree.path);
    if (path !== "") worktrees.set(path, parseWorktree(item));
  }
  return { forge: provider === "github" || provider === "gitlab" ? provider : undefined, worktrees };
}

function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isRecord(value) || !isRecord(value.worktree)) return undefined;
  const { worktree } = value;
  const path = text(worktree.checkout_path);
  const id = text(value.workspace_id);
  if (id === "" || path === "") return undefined;
  const repoRoot = text(worktree.repo_root);
  if (path === repoRoot) return undefined;
  return { id, label: text(value.label), path, repoRoot, repoName: text(worktree.repo_name) };
}

function parseAgent(value: unknown): (AgentInfo & { workspaceId: string }) | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = text(value.pane_id);
  const workspaceId = text(value.workspace_id);
  if (paneId === "" || workspaceId === "") return undefined;
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  const review = text(tokens.review) !== "";
  return {
    paneId,
    workspaceId,
    status: text(value.agent_status),
    blockedToken: text(tokens.agent_blocked) !== "",
    doneToken: text(tokens.agent_done) !== "",
    ...(review && {
      review: { kind: text(tokens.review_kind) || undefined, summary: text(tokens.review_summary) || undefined },
    }),
  };
}

function parseSnapshot(snapshot: unknown): {
  workspaces: Workspace[];
  agents: (AgentInfo & { workspaceId: string })[];
} {
  const inner = isRecord(snapshot) && isRecord(snapshot.result) ? snapshot.result.snapshot : undefined;
  if (!isRecord(inner)) return { workspaces: [], agents: [] };
  return {
    workspaces: list(inner.workspaces).map(parseWorkspace).filter((w) => w !== undefined),
    agents: list(inner.agents).map(parseAgent).filter((a) => a !== undefined),
  };
}

function pickPane(agents: AgentInfo[], chosen: string | undefined): string | undefined {
  if (chosen) return chosen;
  return (
    agents.find((a) => a.status === "blocked" || a.blockedToken) ??
    agents.find((a) => a.status === "done" || a.doneToken) ??
    agents[0]
  )?.paneId;
}

function rowFor(workspace: Workspace, agents: AgentInfo[], repo: RepoList | undefined, sources: Sources): Row {
  const base = {
    workspaceId: workspace.id,
    label: workspace.label,
    path: workspace.path,
    repoRoot: workspace.repoRoot,
    repoName: workspace.repoName,
    live: agents.some((agent) => agent.status === "working"),
    forge: repo?.forge,
  };
  const worktree = repo?.worktrees.get(workspace.path);
  // Without wt's view the board can't say what the branch is, so the row asks
  // to be looked at rather than vanishing into the collapsed count.
  if (worktree === undefined) {
    const reason = repo === undefined ? "wt failed" : "not in wt list";
    return { ...base, branch: "", agentPane: pickPane(agents, undefined), step: "go", reason, flags: [], ignored: [] };
  }

  const prune = worktree.integrated && worktree.pr === undefined;
  const ignored = prune ? sources.ignored(workspace.path) : [];
  const disposition = dispose({ ...worktree, agents, ignored });
  const mark = repo?.forge === "gitlab" ? "!" : "#";
  return {
    ...base,
    branch: worktree.branch,
    ...(worktree.head && { head: worktree.head }),
    ...(worktree.pr && { pr: { number: worktree.pr.number, ref: `${workspace.repoName}${mark}${worktree.pr.number}` } }),
    agentPane: pickPane(agents, disposition.pane),
    step: disposition.step,
    reason: disposition.reason,
    ...(disposition.detail && { detail: disposition.detail }),
    flags: disposition.flags,
    ignored,
  };
}

export function buildRows(sources: Sources): Row[] {
  const { workspaces, agents } = parseSnapshot(sources.snapshot);
  return workspaces
    .map((workspace) =>
      rowFor(
        workspace,
        agents.filter((agent) => agent.workspaceId === workspace.id),
        parseList(sources.wt[workspace.repoRoot]),
        sources,
      ),
    )
    .sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step) || a.label.localeCompare(b.label));
}

export function summarize(rows: Row[]): { needYou: number; finish: number; collapsed: number } {
  const count = (...steps: Step[]) => rows.filter((row) => steps.includes(row.step)).length;
  return { needYou: count("review", "go", "wake"), finish: count("prune"), collapsed: count("collapsed") };
}

function run(cmd: string[]): { ok: boolean; stdout: string } {
  try {
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
    return { ok: result.success, stdout: result.stdout.toString() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function json(cmd: string[]): unknown {
  const result = run(cmd);
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

// --full adds CI, and the summary is a model call the board has no use for.
export function wtList(repoRoot: string): unknown {
  return json(["wt", "-C", repoRoot, "list", "--full", "--format=json", "--config-set", "list.summary=false"]);
}

function ignoredFiles(path: string): string[] {
  return run(["git", "-C", path, "status", "--ignored", "--porcelain"])
    .stdout.split("\n")
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
}

export function repoRoots(snapshot: unknown): string[] {
  return [...new Set(parseSnapshot(snapshot).workspaces.map((workspace) => workspace.repoRoot))];
}

/** Undefined when herdr can't be read, so a down server never reads as an empty board. */
export function loadRows(): Row[] | undefined {
  const snapshot = json(["herdr", "api", "snapshot"]);
  if (snapshot === undefined) return undefined;
  const wt: WtLists = {};
  for (const root of repoRoots(snapshot)) wt[root] = wtList(root);
  return buildRows({ snapshot, wt, ignored: ignoredFiles });
}
