// The half of `wt pr` and `wt mr` that has nothing to do with which forge
// answered: the flags, the merge of an authored set and a review-requested set
// into one picker, and the hand-off to clone-repo and `wt switch`. Each entry
// point supplies only its own two queries, so the two commands cannot drift
// apart in how they sort, dedupe, or open what you picked.

export type Bucket = "mine" | "review";

export interface Request {
  bucket: Bucket;
  // What the picker shows in its second column: "owner/repo#12", "group/proj!12".
  label: string;
  // The repository or project the label names, which the sort groups by.
  project: string;
  number: number;
  title: string;
  // The forge URL, which `wt switch` resolves to a branch and the preview
  // command renders.
  url: string;
  // What clone-repo is given to find or make the checkout.
  checkout: string;
}

export interface Options {
  mine: boolean;
  review: boolean;
  // Everything from the first non-flag onward, forwarded to `wt switch`.
  rest: string[];
}

export type Parse = { ok: true; options: Options } | { ok: false; message: string };

// Stops at the first argument it does not own, so `wt pr -x claude` forwards
// `-x claude` rather than refusing it.
export function parseOptions(args: string[]): Parse {
  let mine = true;
  let review = true;

  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mine") review = false;
    else if (arg === "--review") mine = false;
    else if (arg === "-h" || arg === "--help") return { ok: false, message: "" };
    else break;
  }

  // The shell took each flag as turning the other bucket off, so passing both
  // searched neither and reported "none open" against a forge it never asked.
  if (!mine && !review) return { ok: false, message: "--mine and --review select opposite halves" };

  return { ok: true, options: { mine, review, rest: args.slice(index) } };
}

// Authored wins over review-requested when a request is both, so the first
// occurrence survives and the callers pass the authored set first.
export function ordered(requests: Request[]): Request[] {
  const seen = new Map<string, Request>();
  for (const request of requests) {
    if (!seen.has(request.url)) seen.set(request.url, request);
  }

  return [...seen.values()].sort(
    (left, right) =>
      left.bucket.localeCompare(right.bucket) ||
      left.project.localeCompare(right.project) ||
      left.number - right.number,
  );
}

// fzf reads whole lines, so a title carrying a tab or a newline would split its
// row into fields that are not fields and the selection would map back to the
// wrong request, or to none.
function escape(cell: string): string {
  return cell.replace(/[\t\r\n]/g, " ");
}

export function pickerRow(request: Request): string {
  return [request.bucket, request.label, escape(request.title), request.url, request.checkout].join(
    "\t",
  );
}

export interface Picker {
  // The fzf prompt, and the command it renders the highlighted row with. {4} is
  // the url column.
  prompt: string;
  preview: string;
}

// The chosen request, or undefined when the picker was dismissed. Only the
// first three columns are shown. The url and the checkout ride along so the
// selection carries everything the switch needs.
export function choose(requests: Request[], picker: Picker): Request | undefined {
  const rows = new Map(requests.map((request) => [pickerRow(request), request]));

  // The rows go in over stdin and only stdout is read back. fzf opens the
  // terminal itself to draw on, which is why a piped stdin does not stop it
  // from being interactive.
  const run = spawn({
    cmd: [
      "fzf",
      "--delimiter=\t",
      "--with-nth=1,2,3",
      `--prompt=${picker.prompt}`,
      `--preview=${picker.preview}`,
      "--preview-window=right,60%,border-left",
    ],
    stdin: Buffer.from([...rows.keys()].map((row) => `${row}\n`).join("")),
    stderr: "inherit",
  });

  return rows.get(run?.stdout.toString().replace(/\n+$/, "") ?? "");
}

// clone-repo resolves the checkout, cloning it when this machine has never had
// it, and `wt switch` opens a worktree for the branch behind the URL. The two
// are one step because neither is useful here without the other.
export function switchTo(request: Request, rest: string[]): number {
  const checkout = capture(["clone-repo", request.checkout]);
  if (checkout === undefined || checkout === "") {
    log("error", `could not resolve a checkout for ${request.checkout}`);
    return 1;
  }

  // Inherited on all three streams: `wt switch -x claude` hands the terminal to
  // whatever it launches. The shell exec'd here, so this leaves one more
  // process in the tree than it used to, waiting on the same child.
  const run = spawn({
    cmd: ["wt", "-C", checkout, "switch", request.url, ...rest],
    stdio: ["inherit", "inherit", "inherit"],
  });
  return run?.exitCode ?? 1;
}

// The first tool that is missing, so the caller can name it rather than let the
// failure surface as an empty picker.
export function missingTool(tools: string[]): string | undefined {
  return tools.find((tool) => Bun.which(tool, { PATH: process.env.PATH }) === null);
}

export function log(level: "error" | "warn" | "info", message: string): void {
  spawn({ cmd: ["gum", "log", "--level", level, message], stdio: ["ignore", "ignore", "inherit"] });
}

// Undefined when the command could not be run or exited nonzero. A forge query
// that failed is not an empty result set: reporting "none open" for a network
// error would quietly show half of what is waiting on you.
export function capture(cmd: string[]): string | undefined {
  const run = spawn({ cmd, stdin: "ignore", stderr: "ignore" });
  if (run === undefined || run.exitCode !== 0) return undefined;
  return run.stdout.toString().replace(/\n+$/, "");
}

// Every spawn hands the environment over explicitly, because Bun otherwise
// resolves a bare command name against the PATH it captured at startup and a
// caller that adjusted PATH would reach a different binary than it meant to.
//
// A binary that is not installed throws where the shell printed `command not
// found`. Undefined here rather than a raise: missingTool is what reports an
// absent tool by name, and every other caller already handles an answer it
// could not get.
function spawn(options: Parameters<typeof Bun.spawnSync>[0]): Bun.SyncSubprocess | undefined {
  try {
    return Bun.spawnSync({ ...options, env: process.env });
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
