// The dirty-tree gate the two unattended sync jobs pass through, and the bridge
// from bin/git-sync's exit codes to a notification.
//
// bin/dotfiles-sync and bin/claude-upgrade both fast-forward a public deploy
// checkout at 3am against a locked Mac, where stdin is not a terminal and SSH
// cannot sign. The gate decides whether a dirty tree stops that: it fetches the
// incoming .gitignore first, so a rule shipped alongside the files it covers
// cannot hold the sync shut forever, renders what is dirty into the log, and
// then either skips (unattended) or offers to discard the changes or carry them
// out on a PR (on a terminal). It refuses outright to push anything naming this
// machine to a public remote.

import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { log, type Output } from "./job-output.ts";
import { notify, readLatch, statusFile, writeLatch } from "./report-failure.ts";
import { canonicalJson } from "./sorted-json.ts";

// ~/.dotfiles is a symlink to the checkout, so the sibling commands are found
// through the resolved path rather than the invoked one.
const REPO = dirname(dirname(dirname(realpathSync(import.meta.path))));
const SPIN = join(REPO, "bin", "spin");
const GIT_SYNC = join(REPO, "bin", "git-sync");

const NOT_RUN = 127;

// The three statuses bin/git-sync sync reports, which are git_sync's own.
const SYNC_UPDATED = 0;
const SYNC_CURRENT = 2;

export const DISCARD = "Discard and sync";
export const OPEN_PR = "Open a PR and sync";
export const SKIP = "Skip sync";

export interface ReviewOptions {
  // `[[ ! -t 0 ]]` was the only signal separating the unattended run from the
  // interactive one. It is injected because a test cannot make its own stdin a
  // terminal, and a job that guessed wrong would either prompt into a launchd
  // log or skip a sync someone is watching.
  interactive?: () => boolean;
}

export type SyncResult =
  | { status: "updated"; rev: string }
  | { status: "current" }
  | { status: "failed" };

// Run the sync and map its result. Callers own their own success messages and
// post-update side effects, so only the failure notifies here.
export function syncNotify(
  out: Output,
  repoDir: string,
  title: string,
  branch = "",
): SyncResult {
  const args = branch === "" ? [repoDir] : [repoDir, branch];
  // The rev travels on stdout and the outcome in the status, which is why
  // bin/git-sync keeps every log line and git's own output on stderr.
  const sync = out.read([GIT_SYNC, "sync", ...args], { stdin: "ignore" });

  if (sync.status === SYNC_UPDATED) return { status: "updated", rev: stripNewlines(sync.stdout) };
  if (sync.status === SYNC_CURRENT) return { status: "current" };

  notify(title, "Failed: could not sync");
  return { status: "failed" };
}

// Print the diff of tracked changes against HEAD, then every untracked file as a
// new-file diff. JSON is normalized so cosmetic key reordering does not show as
// noise; everything else falls back to plain `git diff HEAD`.
export function renderDiff(repoDir: string): string {
  const rendered: string[] = [];

  for (const file of lines(gitQuiet(["diff", "HEAD", "--name-only"], repoDir).stdout)) {
    const json = file.endsWith(".json") ? jsonDiff(repoDir, file) : undefined;
    if (json !== undefined) {
      rendered.push(json);
      continue;
    }
    // A path that is no longer a regular file is a deletion, and the gate lists
    // it as blocking. Rendering nothing for it leaves the report naming a path
    // with no evidence attached, so it takes the plain diff like anything else.
    rendered.push(gitQuiet(["diff", "HEAD", "--", file], repoDir).stdout);
  }

  // `git diff HEAD` never names an untracked file, while the gate calls one
  // dirty, so a tree dirty only in untracked paths rendered an empty diff -
  // which was all the report of that block had to go on.
  for (const file of lines(gitQuiet(["ls-files", "--others", "--exclude-standard"], repoDir).stdout)) {
    if (!isFile(join(repoDir, file))) continue;
    rendered.push(gitQuiet(["diff", "--no-index", "--", "/dev/null", file], repoDir).stdout);
  }

  return rendered.join("");
}

// Everything `git add -A` would capture: the tracked diff against HEAD, plus the
// name and contents of every untracked file.
export function* capturableContent(repoDir: string): Generator<string> {
  yield gitQuiet(["diff", "HEAD"], repoDir).stdout;

  // Untracked files are staged too, so they are as publishable as the tracked
  // diff. Their names carry as much as their contents.
  for (const file of lines(gitQuiet(["ls-files", "--others", "--exclude-standard"], repoDir).stdout)) {
    yield `${file}\n`;
    const path = join(repoDir, file);
    if (isFile(path)) yield* fileChunks(path);
  }
}

// An untracked file can be any size, which is why the shell piped this into a
// grep that stopped at the first match rather than holding it. Held whole, a
// tree carrying a few hundred megabytes of untracked content overruns the string
// limit and crashes a job that only had to answer yes or no.
const CHUNK = 1 << 20;
// Enough overlap between chunks that a name spanning the boundary is still one
// run of characters in the chunk that follows it.
const OVERLAP = 256;

function* fileChunks(path: string): Generator<string> {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return;
  }

  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    for (;;) {
      const read = readSync(handle, buffer, 0, CHUNK, null);
      if (read === 0) return;
      const text = buffer.toString("utf8", 0, read);
      yield carry + text;
      carry = text.slice(-OVERLAP);
    }
  } catch {
    return;
  } finally {
    closeSync(handle);
  }
}

// Every name this machine answers to. `hostname` covers the POSIX forms, and
// scutil covers the ones macOS keeps separately: an app asking Cocoa for the
// computer's name gets ComputerName, which a user can set to something the POSIX
// hostname does not contain. Duplicates are harmless, so they are not filtered.
export function hostNames(): string[] {
  const names: string[] = [];

  // Resolved rather than guarded by a platform check, so a test can put its own
  // on PATH and a Linux run that has neither contributes nothing.
  const hostname = Bun.which("hostname", { PATH: process.env.PATH });
  if (hostname !== null) {
    names.push(...lines(commandOutput([hostname, "-s"])));
    names.push(...lines(commandOutput([hostname])));
  }

  const scutil = Bun.which("scutil", { PATH: process.env.PATH });
  if (scutil !== null) {
    for (const key of ["ComputerName", "LocalHostName", "HostName"]) {
      names.push(...lines(commandOutput([scutil, "--get", key])));
    }
  }

  // A blank name would match every line and refuse every sync.
  return names.map((name) => name.trim()).filter((name) => name !== "");
}

export function changesNameHost(repoDir: string): boolean {
  const names = hostNames();
  // No names at all - a machine with neither hostname nor scutil - is no
  // refusal. There is nothing here to leak.
  if (names.length === 0) return false;

  for (const chunk of capturableContent(repoDir)) {
    if (names.some((name) => wholeWord(name).test(chunk))) return true;
  }
  return false;
}

// Capture the working-tree changes onto a fresh branch, push it, and open a
// draft PR, then return the base branch to a clean state so the caller can
// fast-forward it. Refuses before touching the tree when what it would capture
// names this machine, and again once it is staged.
export function openPr(out: Output, repoDir: string, title: string): boolean {
  // The repos this serves are public deploy checkouts, and what lands in them
  // without being written by hand is whatever an app decided to configure -
  // Vibe Island puts the machine's own name into a hook command. Refuse the
  // whole sync, leaving the tree for inspection.
  if (changesNameHost(repoDir)) return refuseNamedHost(out, title);

  const symbolic = stripNewlines(gitQuiet(["symbolic-ref", "--short", "HEAD"], repoDir).stdout);
  const base = symbolic === "" ? defaultBranch(repoDir) : symbolic;
  const branch = `sync/local-changes-${branchTimestamp()}`;

  log(out, "info", `Opening a PR for local changes on ${branch}...`);

  if (out.run(["git", "-C", repoDir, "checkout", "-b", branch]) !== 0) {
    log(out, "error", `Failed to create ${branch}`);
    return false;
  }

  if (out.run(["git", "-C", repoDir, "add", "-A"]) !== 0) {
    log(out, "error", "Failed to stage local changes");
    out.run(["git", "-C", repoDir, "checkout", base]);
    return false;
  }

  // Checked again now that the tree is staged. Vibe Island writes on its own
  // schedule, so a write that landed after the first check would otherwise ride
  // out on this commit.
  if (changesNameHost(repoDir)) {
    refuseNamedHost(out, title);
    // Unstaged, not discarded: the working tree is left as it was for
    // inspection.
    gitQuiet(["reset"], repoDir);
    out.run(["git", "-C", repoDir, "checkout", base]);
    return false;
  }

  // The message names nothing about the machine. It used to carry `hostname -s`,
  // publishing the host to a public remote on every sync, and the branch name
  // already dates the run.
  if (out.run(["git", "-C", repoDir, "commit", "-m", "sync: local changes captured"]) !== 0) {
    log(out, "error", "Failed to commit local changes");
    out.run(["git", "-C", repoDir, "checkout", base]);
    return false;
  }

  const pushed = out.run([
    SPIN,
    "--show-error",
    "--title",
    `Pushing ${branch}`,
    "--",
    "git",
    "-C",
    repoDir,
    "push",
    "-u",
    "origin",
    branch,
  ]);
  if (pushed !== 0) {
    log(out, "error", `Failed to push ${branch} - change is committed locally on ${branch}`);
    out.run(["git", "-C", repoDir, "checkout", base]);
    return false;
  }

  // Both streams, so gh's own complaint reaches the error log.
  const pr = mergedOutput(["gh", "pr", "create", "--draft", "--base", base, "--head", branch, "--fill"], repoDir);
  if (pr.status !== 0) {
    log(out, "error", `Failed to create PR: ${pr.output}`);
    out.run(["git", "-C", repoDir, "checkout", base]);
    return false;
  }

  if (out.run(["git", "-C", repoDir, "checkout", base]) !== 0) {
    log(out, "error", `Failed to return to ${base} - change is safe on ${branch}`);
    return false;
  }

  log(out, "info", `PR opened: ${pr.output}`);
  notify(title, "Opened PR for local changes");
  return true;
}

// Refresh origin/<branch> once, so the gate can read the incoming .gitignore.
// Best effort: bin/git-sync retries properly a moment later, and a failure here
// only costs the gate the incoming rules.
export function reviewFetch(out: Output, repoDir: string, branch: string): number {
  // The shell moved origin's fetch URL to HTTPS here, because an SSH fetch dies
  // on "agent refused operation" while the Mac is locked. bin/git-sync exposes
  // no such subcommand, so the same rewrite reaches this one fetch as an
  // insteadOf rule in its environment instead. The persistent rewrite still
  // happens in bin/git-sync sync, once the gate lets the sync through.
  return out.run([SPIN, "--title", `Fetching origin/${branch}`, "--", "git", "-C", repoDir, "fetch", "origin", branch], {
    env: { ...process.env, ...httpsEnv() },
  });
}

// The paths that still block a sync, one per line. Tracked changes always block.
// Untracked paths are judged against origin/<branch>'s .gitignore when that
// resolves; with no branch, or no such file, the local rules decide.
export function reviewBlocking(repoDir: string, branch = ""): string[] {
  // .gitignore has no say over a path git already tracks, so a tracked change
  // blocks whatever is arriving. The porcelain XY-plus-space prefix is fixed
  // width, and a rename arrives as the single entry `old -> new`.
  const tracked = lines(gitQuiet(["status", "--porcelain", "--untracked-files=no"], repoDir).stdout).map(
    (line) => line.slice(3),
  );

  const exclude = incomingExclude(repoDir, branch);
  const others = ["ls-files", "--others", "--exclude-standard"];
  if (exclude !== "") others.push(`--exclude-from=${exclude}`);

  const untracked = lines(gitQuiet(others, repoDir).stdout);
  if (exclude !== "") rmSync(exclude, { force: true });

  return tracked.concat(untracked);
}

// The incoming rules have to reach ls-files as a real file. Handed a process
// substitution, git sizes the pipe with fstat and reads nothing whenever the
// writer has yet to run, so the exclusions would apply or not by luck of
// scheduling. The git dir holds it: writable wherever the pull this gate guards
// would be, and private to the repo. The pid keeps a hand run overlapping the
// 3am job from deleting the file the other is about to read.
function incomingExclude(repoDir: string, branch: string): string {
  if (branch === "") return "";

  const gitDir = stripNewlines(gitQuiet(["rev-parse", "--absolute-git-dir"], repoDir).stdout);
  if (gitDir === "") return "";

  const incoming = gitQuiet(["show", `origin/${branch}:.gitignore`], repoDir);
  if (incoming.status !== 0) return "";

  const path = join(gitDir, `incoming-exclude-${process.pid}`);
  try {
    writeFileSync(path, incoming.stdout);
  } catch {
    return "";
  }
  return path;
}

// Returns true to continue syncing (nothing blocking, discard, or PR), false to
// abort.
export function reviewDirty(
  out: Output,
  repoDir: string,
  title: string,
  options: ReviewOptions = {},
): boolean {
  const syncing = review(out, repoDir, title, options);
  if (syncing) clearSkips(repoDir);
  return syncing;
}

function review(out: Output, repoDir: string, title: string, options: ReviewOptions): boolean {
  const tree = stripNewlines(gitQuiet(["status", "--porcelain"], repoDir).stdout);
  if (tree === "") return true;

  // A .gitignore rule reaches this checkout only through the pull the gate is
  // about to block, so a rule shipped alongside the files it covers deadlocks:
  // the files hold the gate shut and the gate holds the rule out. Fetching needs
  // no clean tree, so it happens first and the incoming rules get to answer for
  // the paths they were written for. A fetch that fails leaves the local rules
  // deciding, as before.
  let branch = defaultBranch(repoDir);
  if (reviewFetch(out, repoDir, branch) !== 0) branch = "";

  const blocking = reviewBlocking(repoDir, branch);
  if (blocking.length === 0) {
    log(out, "info", `Local changes in ${repoDir} are ignored by the incoming .gitignore - syncing`);
    return true;
  }

  log(out, "info", `Local changes in ${repoDir}:`);
  out.write(2, `${tree}\n`);
  log(out, "info", "Diff:");
  out.write(2, renderDiff(repoDir));

  // The blocking paths get a log line to themselves, ahead of any error.
  // bin/claude-upgrade fingerprints on fields 2-4 of the WARN and ERRO lines,
  // and the error below reads identically whatever is dirty, so without this a
  // block that recurs over a different dirty set files nothing after the first
  // and the deadlock goes silent.
  log(out, "warn", `${blocking.join(" ")} `);

  const interactive = options.interactive ?? (() => process.stdin.isTTY === true);
  if (!interactive()) {
    recordSkip(out, repoDir);
    return skipSync(out, title);
  }

  switch (chooseAction()) {
    case DISCARD:
      log(out, "info", "Discarding local changes...");
      out.run(["git", "-C", repoDir, "reset", "--hard", "HEAD"]);
      // No -x, so ignored files survive.
      out.run(["git", "-C", repoDir, "clean", "-fd"]);
      return true;
    case OPEN_PR:
      return openPr(out, repoDir, title);
    default:
      return skipSync(out, title);
  }
}

// gum draws its UI on stderr and takes the viewport size from the terminal
// stderr points at. A caller that captures stderr, as bin/claude-upgrade does to
// log the run, leaves that size at zero and every frame renders empty, while
// stdin is still the terminal so the keys keep working: an invisible prompt that
// answers the first Enter with whatever the cursor started on. Draw on the
// controlling terminal instead. A gum that could not be run, or was interrupted,
// reads as a skip.
export function chooseAction(): string {
  // Where /dev/tty cannot be opened the shell's redirect failed, gum never ran,
  // and its `||` took the skip. The fallback here runs gum on the inherited
  // stderr instead, which is what lets the interactive path be exercised off a
  // terminal at all. Reaching it in production takes a caller that answers
  // interactive() true with no controlling terminal, and neither job does.
  let tty: number | undefined;
  try {
    tty = openSync("/dev/tty", "w");
  } catch {
    tty = undefined;
  }

  try {
    const chosen = Bun.spawnSync({
      cmd: ["gum", "choose", "--header", "Local changes present. What now?", DISCARD, OPEN_PR, SKIP],
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: tty ?? "inherit",
    });
    if (chosen.exitCode !== 0) return SKIP;
    return stripNewlines(chosen.stdout.toString());
  } catch {
    return SKIP;
  } finally {
    if (tty !== undefined) closeSync(tty);
  }
}

function skipSync(out: Output, title: string): boolean {
  log(out, "error", "Local changes present - skipping sync");
  notify(title, "Skipped: local changes present");
  return false;
}

// An unattended skip reaches someone through a banner that fires at 3am and a
// to-do the jobs latch on the log's warnings, so a tree that stays dirty in the
// same way is filed once and then holds the sync shut in silence. The skips in
// a row are counted per checkout and, from the second on, written into the log
// at the power of two below the count. Each doubling moves the fields the jobs
// fingerprint, so a deadlock left standing files again on a lengthening
// cadence rather than nightly or never. A skip chosen at the prompt is not
// counted: someone was watching.
function recordSkip(out: Output, repoDir: string): void {
  const job = skipJob(repoDir);
  const skips = (Number.parseInt(readLatch(job), 10) || 0) + 1;
  // The count only paces the notifications, so state that cannot be stored
  // leaves the gate logging and skipping as it would with no counter at all.
  // readLatch already swallows its own end of this.
  bestEffort(() => writeLatch(job, String(skips)));
  if (skips < 2) return;
  log(out, "warn", `Sync skipped ${skipBucket(skips)} runs in a row`);
}

function clearSkips(repoDir: string): void {
  bestEffort(() => rmSync(statusFile(skipJob(repoDir)), { force: true }));
}

function bestEffort(store: () => void): void {
  try {
    store();
  } catch {}
}

function skipBucket(skips: number): number {
  return 2 ** (31 - Math.clz32(skips));
}

function skipJob(repoDir: string): string {
  return `sync-skips-${basename(repoDir).replace(LEADING_DOTS, "")}`;
}

const LEADING_DOTS = /^\.+/;

function refuseNamedHost(out: Output, title: string): boolean {
  log(out, "error", "Local changes name this machine - refusing to push them to a public remote");
  notify(title, "Skipped: local changes name this machine");
  return false;
}

export function defaultBranch(repoDir: string): string {
  const branch = stripNewlines(commandOutput([GIT_SYNC, "default-branch", repoDir]));
  return branch === "" ? "main" : branch;
}

// The insteadOf rewrite bin/git-sync would export, as an environment to hand a
// single child. The rule outranks a pushurl, so it is never taken on
// process-wide.
export function httpsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines(commandOutput([GIT_SYNC, "https-env"]))) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

// -w in grep terms: the match has to be bounded by something that is not a word
// constituent, so a short machine name does not match inside an unrelated word
// and refuse a sync over nothing. The boundaries are asserted around the match
// rather than with \b, which answers for the match's own edge characters and
// would let a name ending in punctuation match mid-word.
function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A changed .json renders as the difference between its sorted form at HEAD and
// its sorted form now, so a key reorder shows as nothing. Anything that does not
// parse on both sides - a file that is no longer valid JSON, or a path that does
// not exist at HEAD - falls back to the plain diff.
function jsonDiff(repoDir: string, file: string): string | undefined {
  const path = join(repoDir, file);
  if (!isFile(path)) return undefined;

  const head = gitQuiet(["show", `HEAD:${file}`], repoDir);
  if (head.status !== 0) return undefined;

  const headSorted = canonicalJson(head.stdout);
  const workingSorted = canonicalJson(readText(path));
  if (headSorted === undefined || workingSorted === undefined) return undefined;

  return unifiedDiff(file, headSorted, workingSorted);
}

function unifiedDiff(file: string, before: string, after: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "git-diff-review-"));
  try {
    const left = join(scratch, "before");
    const right = join(scratch, "after");
    writeFileSync(left, `${before}\n`);
    writeFileSync(right, `${after}\n`);
    // A difference exits 1, which says nothing this caller acts on.
    return commandOutput(["diff", "-u", "--label", `a/${file}`, "--label", `b/${file}`, left, right]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A git command whose stdout is the answer and whose complaints the shell
// discarded. A repo_dir that does not exist yields nothing, as the failed `cd`
// did.
function gitQuiet(args: string[], cwd: string): { status: number; stdout: string } {
  try {
    const run = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return { status: run.exitCode, stdout: run.stdout.toString() };
  } catch {
    return { status: NOT_RUN, stdout: "" };
  }
}

function commandOutput(cmd: string[]): string {
  try {
    const run = Bun.spawnSync({
      cmd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return run.stdout.toString();
  } catch {
    return "";
  }
}

function mergedOutput(cmd: string[], cwd: string): { status: number; output: string } {
  try {
    const run = Bun.spawnSync({
      cmd,
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: run.exitCode,
      output: stripNewlines(`${run.stdout.toString()}${run.stderr.toString()}`),
    };
  } catch {
    return { status: NOT_RUN, output: "" };
  }
}

function branchTimestamp(at = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

// Command substitution stripped these, and every value read off a child's stdout
// here was read through one.
export function stripNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
