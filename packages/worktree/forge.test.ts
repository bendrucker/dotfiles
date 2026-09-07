import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capture,
  choose,
  count,
  isRecord,
  missingTool,
  ordered,
  parseOptions,
  pickerRow,
  type Request,
  switchTo,
  text,
} from "./forge.ts";

// Keeps the rows it was offered so a case can assert what the picker saw, and
// echoes the line FZF_PICK names. No pick is a dismissal, which real fzf
// reports as 130 with nothing on stdout.
const FZF_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "fzf stub"; exit 0; }
printf '%s\\n' "$*" >"$FZF_ARGS"
cat >"$FZF_STDIN"
[ -n "$FZF_PICK" ] || exit 130
sed -n "\${FZF_PICK}p" "$FZF_STDIN"
`;

// A missing CLONE_PATH is the resolution failing, an empty one the answer that
// named no directory.
const CLONE_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "clone-repo stub"; exit 0; }
printf '%s\\n' "$*" >>"$CLONE_LOG"
[ -f "$CLONE_PATH" ] || exit 1
cat "$CLONE_PATH"
`;

const WT_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "wt stub"; exit 0; }
printf '%s\\n' "$*" >>"$WT_LOG"
exit "\${WT_EXIT:-0}"
`;

const GUM_STUB = `#!/usr/bin/env bash
[ "$1" = "--stub-check" ] && { echo "gum stub"; exit 0; }
printf '%s\\n' "$*" >>"$GUM_LOG"
`;

const STUBBED = ["fzf", "clone-repo", "wt", "gum"];
const PICKER = { prompt: "pr> ", preview: "gh pr view {4}" };
const environment = { PATH: process.env.PATH };

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "worktree-forge-"));

  const stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  writeStub(join(stubs, "fzf"), FZF_STUB);
  writeStub(join(stubs, "clone-repo"), CLONE_STUB);
  writeStub(join(stubs, "wt"), WT_STUB);
  writeStub(join(stubs, "gum"), GUM_STUB);

  process.env.PATH = `${stubs}:${environment.PATH}`;
  process.env.FZF_ARGS = join(sandbox, "fzf.args");
  process.env.FZF_STDIN = join(sandbox, "fzf.stdin");
  process.env.CLONE_LOG = join(sandbox, "clone.log");
  process.env.CLONE_PATH = join(sandbox, "clone.path");
  process.env.WT_LOG = join(sandbox, "wt.log");
  process.env.GUM_LOG = join(sandbox, "gum.log");
  delete process.env.FZF_PICK;
  delete process.env.WT_EXIT;

  for (const log of ["CLONE_LOG", "WT_LOG", "GUM_LOG"]) {
    writeFileSync(process.env[log] as string, "");
  }
  writeFileSync(process.env.CLONE_PATH, "/checkouts/repo\n");

  proveStubs();
});

afterEach(() => {
  process.env.PATH = environment.PATH;
  for (const name of [
    "FZF_ARGS",
    "FZF_STDIN",
    "FZF_PICK",
    "CLONE_LOG",
    "CLONE_PATH",
    "WT_LOG",
    "WT_EXIT",
    "GUM_LOG",
  ]) {
    delete process.env[name];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function writeStub(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// The PATH edit above is the whole isolation these cases have. A stub that did
// not shadow its real binary would let a case reach the forge, open a picker on
// the terminal, or clone a repository and still look like it passed.
function proveStubs(): void {
  for (const name of STUBBED) {
    const run = Bun.spawnSync({ cmd: [name, "--stub-check"], env: process.env, stdin: "ignore" });
    const said = run.stdout.toString().trim();
    if (said !== `${name} stub`) {
      throw new Error(`the ${name} stub is not on PATH: --stub-check said ${JSON.stringify(said)}`);
    }
  }
}

function read(name: "FZF_ARGS" | "FZF_STDIN" | "CLONE_LOG" | "WT_LOG" | "GUM_LOG"): string {
  return readFileSync(process.env[name] as string, "utf8");
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    bucket: "mine",
    label: "owner/repo#1",
    project: "owner/repo",
    number: 1,
    title: "a title",
    url: "https://github.com/owner/repo/pull/1",
    checkout: "owner/repo",
    ...overrides,
  };
}

describe("parseOptions", () => {
  test.each<{ name: string; args: string[]; mine: boolean; review: boolean; rest: string[] }>([
    { name: "no flags searches both halves", args: [], mine: true, review: true, rest: [] },
    { name: "--mine drops the review half", args: ["--mine"], mine: true, review: false, rest: [] },
    {
      name: "--review drops the authored half",
      args: ["--review"],
      mine: false,
      review: true,
      rest: [],
    },
    {
      name: "a repeated flag is the same flag",
      args: ["--mine", "--mine"],
      mine: true,
      review: false,
      rest: [],
    },
    {
      name: "an unknown option starts the rest",
      args: ["-x", "claude"],
      mine: true,
      review: true,
      rest: ["-x", "claude"],
    },
    {
      name: "flags are consumed before the rest",
      args: ["--mine", "-x", "claude"],
      mine: true,
      review: false,
      rest: ["-x", "claude"],
    },
    {
      name: "a --review past the first non-flag belongs to the rest",
      args: ["-x", "--review"],
      mine: true,
      review: true,
      rest: ["-x", "--review"],
    },
  ])("$name", ({ args, mine, review, rest }) => {
    expect(parseOptions(args)).toEqual({ ok: true, options: { mine, review, rest } });
  });

  test.each(["-h", "--help"])("%s asks for the usage", (flag) => {
    expect(parseOptions([flag])).toEqual({ ok: false, message: "" });
  });

  // The shell read each flag as turning the other bucket off, so both together
  // searched neither and reported "none open" against a forge it never asked.
  test("refuses both halves at once", () => {
    expect(parseOptions(["--mine", "--review"])).toEqual({
      ok: false,
      message: "--mine and --review select opposite halves",
    });
  });
});

describe("ordered", () => {
  test("keeps the first request holding a url", () => {
    const authored = makeRequest({ bucket: "mine" });
    const requested = makeRequest({ bucket: "review", label: "same url, other bucket" });

    expect(ordered([authored, requested])).toEqual([authored]);
  });

  test("sorts by bucket, then project, then number", () => {
    const rows = [
      makeRequest({ bucket: "review", project: "a/a", number: 1, url: "review-a1" }),
      makeRequest({ bucket: "mine", project: "b/b", number: 2, url: "mine-b2" }),
      makeRequest({ bucket: "mine", project: "b/b", number: 1, url: "mine-b1" }),
      makeRequest({ bucket: "mine", project: "a/a", number: 9, url: "mine-a9" }),
    ];

    expect(ordered(rows).map((request) => request.url)).toEqual([
      "mine-a9",
      "mine-b1",
      "mine-b2",
      "review-a1",
    ]);
  });
});

describe("pickerRow", () => {
  test("lays the request out in five columns", () => {
    expect(pickerRow(makeRequest())).toBe(
      "mine\towner/repo#1\ta title\thttps://github.com/owner/repo/pull/1\towner/repo",
    );
  });

  // fzf reads whole lines and splits them on tabs, so either character in a
  // title would map the selection back to the wrong request, or to none.
  test("flattens a title carrying tabs and newlines", () => {
    const row = pickerRow(makeRequest({ title: "one\ttwo\r\nthree" }));
    expect(row.split("\t")[2]).toBe("one two  three");
  });
});

describe("choose", () => {
  test("returns the request behind the chosen row", () => {
    const first = makeRequest({ number: 1, url: "first" });
    const second = makeRequest({ number: 2, url: "second" });
    process.env.FZF_PICK = "2";

    expect(choose([first, second], PICKER)).toBe(second);
    expect(read("FZF_STDIN")).toBe(`${pickerRow(first)}\n${pickerRow(second)}\n`);
  });

  test("shows the prompt and the preview command it was given", () => {
    process.env.FZF_PICK = "1";
    choose([makeRequest()], PICKER);

    expect(read("FZF_ARGS")).toContain("--prompt=pr> ");
    expect(read("FZF_ARGS")).toContain("--preview=gh pr view {4}");
  });

  test("returns nothing when the picker is dismissed", () => {
    expect(choose([makeRequest()], PICKER)).toBeUndefined();
  });
});

describe("switchTo", () => {
  test("opens the checkout clone-repo resolved and forwards the rest", () => {
    expect(switchTo(makeRequest(), ["-x", "claude"])).toBe(0);
    expect(read("CLONE_LOG")).toBe("owner/repo\n");
    expect(read("WT_LOG")).toBe(
      "-C /checkouts/repo switch https://github.com/owner/repo/pull/1 -x claude\n",
    );
  });

  test("answers with the status the switch exited on", () => {
    process.env.WT_EXIT = "3";
    expect(switchTo(makeRequest(), [])).toBe(3);
  });

  test.each<{ name: string; setup: () => void }>([
    { name: "clone-repo failed", setup: () => rmSync(process.env.CLONE_PATH as string) },
    {
      name: "clone-repo named no directory",
      setup: () => writeFileSync(process.env.CLONE_PATH as string, ""),
    },
  ])("reports the checkout it could not resolve when $name", ({ setup }) => {
    setup();

    expect(switchTo(makeRequest(), [])).toBe(1);
    expect(read("WT_LOG")).toBe("");
    expect(read("GUM_LOG")).toBe("log --level error could not resolve a checkout for owner/repo\n");
  });
});

describe("missingTool", () => {
  test("names the first tool that is absent", () => {
    expect(missingTool(["wt", "not-installed-here", "also-not-installed"])).toBe(
      "not-installed-here",
    );
  });

  test("answers with nothing when every tool is on PATH", () => {
    expect(missingTool(STUBBED)).toBeUndefined();
  });
});

describe("capture", () => {
  test("trims the trailing newlines off what the command printed", () => {
    expect(capture(["clone-repo", "owner/repo"])).toBe("/checkouts/repo");
  });

  // A forge query that failed is not an empty result set. Reporting "none open"
  // for a network error would quietly show half of what is waiting on you.
  test("answers with nothing when the command exited nonzero", () => {
    rmSync(process.env.CLONE_PATH as string);
    expect(capture(["clone-repo", "owner/repo"])).toBeUndefined();
  });

  test("answers with nothing when the command is not installed", () => {
    expect(capture(["not-installed-here"])).toBeUndefined();
  });
});

describe("narrowing", () => {
  test.each<{ name: string; value: unknown; expected: boolean }>([
    { name: "an object is a record", value: { a: 1 }, expected: true },
    { name: "null is not a record", value: null, expected: false },
    { name: "an array is not a record", value: [1], expected: false },
    { name: "a string is not a record", value: "a", expected: false },
  ])("$name", ({ value, expected }) => {
    expect(isRecord(value)).toBe(expected);
  });

  test.each<{ name: string; value: unknown; expected: string }>([
    { name: "a string passes through as text", value: "a", expected: "a" },
    { name: "a number is not text", value: 1, expected: "" },
    { name: "a missing field is not text", value: undefined, expected: "" },
  ])("$name", ({ value, expected }) => {
    expect(text(value)).toBe(expected);
  });

  test.each<{ name: string; value: unknown; expected: number }>([
    { name: "a number passes through as a count", value: 12, expected: 12 },
    { name: "a numeric string is not a count", value: "12", expected: 0 },
    { name: "a missing field is not a count", value: undefined, expected: 0 },
  ])("$name", ({ value, expected }) => {
    expect(count(value)).toBe(expected);
  });
});
