import { describe, expect, test } from "bun:test";
import { fakeIo } from "#harness";
import {
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

const PICKER = { prompt: "pr> ", preview: "gh pr view {4}" };

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
    const io = fakeIo({ answers: [{ argv: ["fzf"], stdout: `${pickerRow(second)}\n` }] });

    expect(choose(io, [first, second], PICKER)).toBe(second);
    expect(io.calls[0]?.options?.stdin).toEqual({
      input: `${pickerRow(first)}\n${pickerRow(second)}\n`,
    });
  });

  test("shows the prompt and the preview command it was given", () => {
    const io = fakeIo({ answers: [{ argv: ["fzf"] }] });
    choose(io, [makeRequest()], PICKER);

    expect(io.calls[0]?.argv).toContain("--prompt=pr> ");
    expect(io.calls[0]?.argv).toContain("--preview=gh pr view {4}");
  });

  // Real fzf reports a dismissal as 130 with nothing on stdout.
  test("returns nothing when the picker is dismissed", () => {
    const io = fakeIo({ answers: [{ argv: ["fzf"], status: 130 }] });
    expect(choose(io, [makeRequest()], PICKER)).toBeUndefined();
  });

  test("returns nothing when fzf is not installed", () => {
    expect(choose(fakeIo(), [makeRequest()], PICKER)).toBeUndefined();
  });
});

describe("switchTo", () => {
  const CLONED = { argv: ["clone-repo"], stdout: "/checkouts/repo\n" };

  test("opens the checkout clone-repo resolved and forwards the rest", () => {
    const io = fakeIo({ answers: [CLONED, { argv: ["wt"] }] });

    expect(switchTo(io, makeRequest(), ["-x", "claude"])).toBe(0);
    expect(io.calls.map((call) => call.argv)).toEqual([
      ["clone-repo", "owner/repo"],
      ["wt", "-C", "/checkouts/repo", "switch", "https://github.com/owner/repo/pull/1", "-x", "claude"],
    ]);
  });

  test("hands the switch the terminal's stdin", () => {
    const io = fakeIo({ answers: [CLONED, { argv: ["wt"] }] });
    switchTo(io, makeRequest(), []);

    const [, wt] = io.calls;
    expect(wt?.method).toBe("run");
    expect(wt?.options?.stdin).toBeUndefined();
  });

  test("answers with the status the switch exited on", () => {
    const io = fakeIo({ answers: [CLONED, { argv: ["wt"], status: 3 }] });
    expect(switchTo(io, makeRequest(), [])).toBe(3);
  });

  test.each<{ name: string; answer: { argv: string[]; status?: number; stdout?: string } }>([
    { name: "clone-repo failed", answer: { argv: ["clone-repo"], status: 1 } },
    { name: "clone-repo named no directory", answer: { argv: ["clone-repo"], stdout: "" } },
    { name: "clone-repo is not installed", answer: { argv: ["clone-repo"], status: 127 } },
  ])("reports the checkout it could not resolve when $name", ({ answer }) => {
    const io = fakeIo({ answers: [answer, { argv: ["wt"] }] });

    expect(switchTo(io, makeRequest(), [])).toBe(1);
    expect(io.calls.map((call) => call.argv[0])).toEqual(["clone-repo"]);
    expect(io.logs).toEqual([
      { level: "error", message: "could not resolve a checkout for owner/repo" },
    ]);
  });
});

describe("missingTool", () => {
  test("names the first tool that is absent", () => {
    expect(missingTool(["sh", "not-installed-here", "also-not-installed"])).toBe(
      "not-installed-here",
    );
  });

  test("answers with nothing when every tool is on PATH", () => {
    expect(missingTool(["sh", "ls"])).toBeUndefined();
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
