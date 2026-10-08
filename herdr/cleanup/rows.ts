import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispose,
  type AgentInfo,
  type Checks,
  type DispositionInput,
  type PrInfo,
  type PrState,
  type Step,
} from "./disposition";

export type Forge = "github" | "gitlab";

export interface Row {
  workspaceId: string;
  label: string;
  path: string;
  repoRoot: string;
  repoName: string;
  branch: string;
  forge: Forge | undefined;
  pr?: { number: number; state: PrState; ref: string };
  /** The pane to focus or wake. */
  agentPane?: string;
  step: Step;
  reason: string;
  flags: string[];
  ignored: string[];
  fetchedAt?: string;
  machine?: string;
}

export interface GitFacts {
  originUrl?: string;
  ignored: string[];
}

export interface Sources {
  snapshot: unknown;
  caches: Record<string, unknown>;
  agentState: unknown;
  git: (path: string) => GitFacts;
  now: number;
}

interface Workspace {
  id: string;
  label: string;
  path: string;
  repoRoot: string;
  repoName: string;
}

interface Cache {
  branch: string;
  prs: PrInfo[];
  unpushed: number;
  dirty: boolean;
  fetchedAt?: string;
}

const PR_STATES: readonly string[] = ["OPEN", "MERGED", "CLOSED"];
const CHECKS: readonly string[] = ["ok", "fail", "pending", "none"];
const STEP_ORDER: Step[] = ["go", "wake", "prune", "collapsed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPrState(value: unknown): value is PrState {
  return typeof value === "string" && PR_STATES.includes(value);
}

function isChecks(value: unknown): value is Checks {
  return typeof value === "string" && CHECKS.includes(value);
}

function parsePr(value: unknown): PrInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { number, state, draft, conflicting, checks, updated } = value;
  if (typeof number !== "number" || !isPrState(state) || !isChecks(checks)) return undefined;
  return {
    number,
    state,
    draft: draft === true,
    conflicting: conflicting === true,
    checks,
    updated: text(updated),
  };
}

function parseCache(value: unknown): Cache | undefined {
  if (!isRecord(value) || !Array.isArray(value.prs)) return undefined;
  const prs = value.prs.map(parsePr);
  if (prs.some((pr) => pr === undefined)) return undefined;
  return {
    branch: text(value.branch),
    prs: prs.filter((pr) => pr !== undefined),
    unpushed: typeof value.unpushed === "number" ? value.unpushed : 0,
    dirty: value.dirty === true,
    fetchedAt: text(value.fetched_at) || undefined,
  };
}

function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isRecord(value) || !isRecord(value.worktree)) return undefined;
  const { worktree } = value;
  const path = text(worktree.checkout_path);
  const id = text(value.workspace_id);
  if (id === "" || path === "") return undefined;
  const repoRoot = text(worktree.repo_root);
  if (path === repoRoot) return undefined;
  return {
    id,
    label: text(value.label),
    path,
    repoRoot,
    repoName: text(worktree.repo_name),
  };
}

function parseAgent(value: unknown): (AgentInfo & { workspaceId: string }) | undefined {
  if (!isRecord(value)) return undefined;
  const paneId = text(value.pane_id);
  const workspaceId = text(value.workspace_id);
  if (paneId === "" || workspaceId === "") return undefined;
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  return {
    paneId,
    workspaceId,
    status: text(value.agent_status),
    blockedToken: text(tokens.agent_blocked) !== "",
    doneToken: text(tokens.agent_done) !== "",
  };
}

function parseSnapshot(snapshot: unknown): {
  workspaces: Workspace[];
  agents: (AgentInfo & { workspaceId: string })[];
} {
  const inner = isRecord(snapshot) && isRecord(snapshot.result) ? snapshot.result.snapshot : undefined;
  if (!isRecord(inner)) return { workspaces: [], agents: [] };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return {
    workspaces: list(inner.workspaces).map(parseWorkspace).filter((w) => w !== undefined),
    agents: list(inner.agents).map(parseAgent).filter((a) => a !== undefined),
  };
}

function parseLastWorked(agentState: unknown): Record<string, number> {
  const lastWorked: Record<string, number> = {};
  if (!isRecord(agentState)) return lastWorked;
  for (const [pane, entry] of Object.entries(agentState)) {
    if (isRecord(entry) && typeof entry.lastWorkingAt === "number" && Number.isFinite(entry.lastWorkingAt)) {
      lastWorked[pane] = entry.lastWorkingAt;
    }
  }
  return lastWorked;
}

export function forgeOf(originUrl: string | undefined): Forge | undefined {
  if (!originUrl) return undefined;
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(originUrl.trim());
  if (!match?.[1]) return undefined;
  return match[1].toLowerCase() === "github.com" ? "github" : "gitlab";
}

function newestPr(prs: PrInfo[]): PrInfo | undefined {
  const open = prs.filter((pr) => pr.state === "OPEN");
  const pool = open.length > 0 ? open : prs;
  return pool.reduce<PrInfo | undefined>(
    (best, pr) => (best === undefined || Date.parse(pr.updated) > Date.parse(best.updated) ? pr : best),
    undefined,
  );
}

function pickPane(agents: AgentInfo[], woken: string | undefined): string | undefined {
  if (woken) return woken;
  return (
    agents.find((a) => a.status === "blocked" || a.blockedToken) ??
    agents.find((a) => a.status === "done" || a.doneToken) ??
    agents[0]
  )?.paneId;
}

function rowFor(
  workspace: Workspace,
  agents: AgentInfo[],
  cache: Cache | undefined,
  sources: Sources,
  lastWorked: Record<string, number>,
): Row {
  const git = sources.git(workspace.path);
  const forge = forgeOf(git.originUrl);
  const input: DispositionInput = {
    prs: cache?.prs ?? [],
    agents,
    lastWorked,
    dirty: cache?.dirty ?? false,
    unpushed: cache?.unpushed ?? 0,
    ignored: git.ignored,
  };
  const disposition = dispose(input, sources.now);
  const pr = newestPr(input.prs);
  const mark = forge === "gitlab" ? "!" : "#";

  return {
    workspaceId: workspace.id,
    label: workspace.label,
    path: workspace.path,
    repoRoot: workspace.repoRoot,
    repoName: workspace.repoName,
    branch: cache?.branch ?? "",
    forge,
    pr: pr && { number: pr.number, state: pr.state, ref: `${workspace.repoName}${mark}${pr.number}` },
    agentPane: pickPane(agents, disposition.pane),
    step: disposition.step,
    reason: disposition.reason,
    flags: disposition.flags,
    ignored: git.ignored,
    fetchedAt: cache?.fetchedAt,
  };
}

export function buildRows(sources: Sources): Row[] {
  const { workspaces, agents } = parseSnapshot(sources.snapshot);
  const lastWorked = parseLastWorked(sources.agentState);

  return workspaces
    .map((workspace) =>
      rowFor(
        workspace,
        agents.filter((agent) => agent.workspaceId === workspace.id),
        parseCache(sources.caches[workspace.id]),
        sources,
        lastWorked,
      ),
    )
    .sort(
      (a, b) =>
        STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step) || a.label.localeCompare(b.label),
    );
}

export function summarize(rows: Row[]): {
  needYou: number;
  finish: number;
  collapsed: number;
  oldestFetch?: string;
} {
  const count = (...steps: Step[]) => rows.filter((row) => steps.includes(row.step)).length;
  const fetched = rows.map((row) => row.fetchedAt).filter((at) => at !== undefined);
  return {
    needYou: count("go", "wake"),
    finish: count("prune"),
    collapsed: count("collapsed"),
    oldestFetch: fetched.sort()[0],
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readCaches(cacheDir: string): Record<string, unknown> {
  const caches: Record<string, unknown> = {};
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return caches;
  }
  for (const name of names) {
    if (name.endsWith(".json")) caches[name.slice(0, -".json".length)] = readJson(join(cacheDir, name));
  }
  return caches;
}

function run(cmd: string[]): string {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
  return result.success ? result.stdout.toString() : "";
}

function gitFacts(path: string): GitFacts {
  const originUrl = run(["git", "-C", path, "config", "--get", "remote.origin.url"]).trim();
  const ignored = run(["git", "-C", path, "status", "--ignored", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3));
  return { originUrl: originUrl || undefined, ignored };
}

export function loadRows(options: { cacheDir: string; agentStatePath: string; now: number }): Row[] {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(run(["herdr", "api", "snapshot"]));
  } catch {
    snapshot = undefined;
  }
  return buildRows({
    snapshot,
    caches: readCaches(options.cacheDir),
    agentState: readJson(options.agentStatePath),
    git: gitFacts,
    now: options.now,
  });
}
