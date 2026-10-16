// What the PostToolUse and Stop hooks share: which pre-commit runner to use,
// and a check that runs it alongside lint-ts over a set of files.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { lint } from "../../scripts/lint-ts";

export const root = process.env.CLAUDE_PROJECT_DIR ?? ".";
export const cacheRoot = process.env.CLAUDE_CODE_TMPDIR ?? "/tmp";

// gitleaks-system scans the staged index rather than the files it is given, so
// after an edit it reads whatever happens to be staged, at up to seconds a run.
// It still runs at commit time, where the staged index is what is committed.
// The oxlint hook lints the whole tree and runs bun install first, which is
// what a commit wants. lintTs below covers the edited files instead.
const SKIPPED = ["gitleaks-system", "oxlint"];

export interface Runner {
  name: string;
  env: Record<string, string>;
}

export interface Result {
  passed: boolean;
  output: string;
}

export async function payload(): Promise<unknown> {
  try {
    return JSON.parse(await Bun.stdin.text());
  } catch {
    return undefined;
  }
}

export function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

// A non-empty string at the end of the key path, or undefined for a missing or
// differently shaped field.
export function field(value: unknown, ...keys: string[]): string | undefined {
  const found = at(value, ...keys);
  return typeof found === "string" && found !== "" ? found : undefined;
}

// Undefined when the project has no pre-commit config or neither runner is
// installed, and the hooks then exit without checking.
export function runner(): Runner | undefined {
  if (!existsSync(join(root, ".pre-commit-config.yaml"))) return undefined;
  mkdirSync(cacheRoot, { recursive: true });
  const skip = [process.env.SKIP, ...SKIPPED].filter(Boolean).join(",");
  if (Bun.which("prek")) return { name: "prek", env: { SKIP: skip, PREK_HOME: process.env.PREK_HOME ?? join(cacheRoot, "prek") } };
  if (Bun.which("pre-commit")) {
    return { name: "pre-commit", env: { SKIP: skip, PRE_COMMIT_HOME: process.env.PRE_COMMIT_HOME ?? join(cacheRoot, "pre-commit") } };
  }
  return undefined;
}

async function lintTs(paths: string[]): Promise<Result> {
  let output = "";
  let status: number;
  try {
    status = await lint(root, ["--deny-warnings", "--", ...paths], (_, text) => (output += text), { install: true });
  } catch (error) {
    output += `${error instanceof Error ? error.message : error}\n`;
    status = 1;
  }
  if (status === 0) return { passed: true, output: "" };
  return { passed: false, output: `oxlint (scripts/lint-ts)...Failed\n${output}` };
}

// Runs both whatever the other reports, so one pass names every finding. lint
// runs while the runner does, but a fixer may rewrite a file while oxlint reads
// it, so after a failed run it lints again and reports that result instead.
export async function check(run: Runner, paths: string[]): Promise<Result> {
  const child = Bun.spawn([run.name, "run", "--files", ...paths], {
    env: { ...process.env, ...run.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const linted = await lintTs(paths);
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status === 0) return linted;
  const relinted = await lintTs(paths);
  return { passed: false, output: `${stdout}${stderr}${relinted.output}` };
}
