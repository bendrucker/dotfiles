import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Exit, must } from "./process.ts";

export type Mode = "fresh" | "upgrade";

// The layout an upgrade run starts from: origin/main before the move to
// `mise bootstrap`. The oldlayout image is built at this commit, so moving it
// means rebuilding that image.
export const OLDLAYOUT_COMMIT = "0c7e84c7f31af6194ed4f1bdd7ae3353634bfe76";

export interface Guest {
  /** The VM or container, as a failure names it. */
  name: string;
  /** Where the host's git dir is mounted inside the guest. */
  share: string;
  /** Run a command as the guest's unprivileged user. */
  exec(cmd: string[], options?: { stdin?: Uint8Array; capture?: boolean }): Exit;
}

export interface Check {
  name: string;
  cmd: string[];
}

interface Phase {
  name: string;
  passed: boolean;
  seconds: number;
}

export class Report {
  readonly phases: Phase[] = [];

  constructor(
    readonly title: string,
    readonly skipped: string[] = [],
  ) {}

  phase(name: string, body: () => boolean): boolean {
    const start = performance.now();
    const passed = body();
    this.phases.push({ name, passed, seconds: Math.round((performance.now() - start) / 1000) });
    return passed;
  }

  async phaseAsync(name: string, body: () => Promise<void>): Promise<void> {
    const start = performance.now();
    let passed = false;
    try {
      await body();
      passed = true;
    } finally {
      this.phases.push({ name, passed, seconds: Math.round((performance.now() - start) / 1000) });
    }
  }

  fail(name: string): void {
    this.phases.push({ name, passed: false, seconds: 0 });
  }

  get passed(): boolean {
    return this.phases.length > 0 && this.phases.every((phase) => phase.passed);
  }

  format(): string {
    const total = this.phases.reduce((sum, phase) => sum + phase.seconds, 0);
    const width = Math.max(...this.phases.map((phase) => phase.name.length));
    const lines = [`${this.title}: ${this.passed ? "passed" : "failed"} in ${duration(total)}`];
    for (const phase of this.phases) {
      lines.push(`  ${phase.passed ? "passed" : "FAILED"}  ${phase.name.padEnd(width)}  ${duration(phase.seconds)}`);
    }
    for (const reason of this.skipped) lines.push(`  skipped ${reason}`);
    return lines.join("\n");
  }
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** The repo's shared git dir, which every worktree's commits live in. */
export function gitCommonDir(root: string): string {
  return must(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { capture: true }).trim();
}

function script(guest: Guest, name: string, args: string[], capture = false): Exit {
  const stdin = new Uint8Array(readFileSync(join(import.meta.dir, "guest", name)));
  return guest.exec(["bash", "-s", "--", ...args], { stdin, capture });
}

const SETUP = ["bash", "-c", 'exec "$HOME/src/dotfiles/scripts/setup"'];

/** Check out `commit` in the guest and run the installer once. */
export function converge(guest: Guest, report: Report, commit: string): boolean {
  const short = commit.slice(0, 8);
  return (
    report.phase(`seed ${short}`, () => script(guest, "seed.sh", [guest.share, commit]).status === 0) &&
    report.phase(`setup ${short}`, () => guest.exec(SETUP).status === 0)
  );
}

/** Run the installer again, failing when it moved a link, then run the checks. */
export function verify(guest: Guest, report: Report, checks: Check[] = []): boolean {
  const before = script(guest, "links.sh", [], true);
  if (!report.phase("setup again", () => guest.exec(SETUP).status === 0)) return false;
  const after = script(guest, "links.sh", [], true);
  report.phase("second run moved no link", () => {
    if (before.status !== 0 || after.status !== 0) return false;
    if (before.stdout === after.stdout) return true;
    process.stderr.write(diff(before.stdout, after.stdout));
    return false;
  });
  for (const check of checks) report.phase(check.name, () => guest.exec(check.cmd).status === 0);
  return report.passed;
}

function diff(before: string, after: string): string {
  const old = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  const removed = [...old].filter((line) => line && !now.has(line)).map((line) => `- ${line}`);
  const added = [...now].filter((line) => line && !old.has(line)).map((line) => `+ ${line}`);
  return [...removed, ...added, ""].join("\n");
}
