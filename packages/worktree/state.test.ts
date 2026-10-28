import { describe, expect, test } from "bun:test";
import { fakeIo } from "#harness";
import { defaultBranch, listWorktrees, prState, quietOutput, remoteHost } from "./state.ts";

describe("quietOutput", () => {
  test("trims trailing newlines and closes stdin and stderr", () => {
    const io = fakeIo({ answers: [{ argv: ["tool"], stdout: "value\n\n" }] });

    expect(quietOutput(io, ["tool"])).toBe("value");
    expect(io.calls[0]?.options).toEqual({ stdin: "ignore", stderr: "ignore" });
  });

  // A forge CLI that is missing or failing reads as no answer, never as a throw.
  test.each<{ name: string; status: number; stdout: string }>([
    { name: "a nonzero status keeps what was printed", status: 1, stdout: "partial\n" },
    { name: "a command that cannot run prints nothing", status: 127, stdout: "" },
  ])("$name", ({ status, stdout }) => {
    const io = fakeIo({ answers: [{ argv: ["tool"], status, stdout }] });
    expect(quietOutput(io, ["tool"])).toBe(stdout.replace(/\n+$/, ""));
  });
});

describe("readers over Io", () => {
  test("defaultBranch is empty when wt cannot be run", () => {
    expect(defaultBranch(fakeIo())).toBe("");
  });

  test("remoteHost reads the host out of the configured url", () => {
    const io = fakeIo({
      answers: [{ argv: ["git", "config"], stdout: "git@github.com:o/r.git\n" }],
    });
    expect(remoteHost(io)).toBe("github.com");
  });

  test("listWorktrees is undefined when wt says nothing", () => {
    expect(listWorktrees(fakeIo({ answers: [{ argv: ["wt"] }] }))).toBeUndefined();
  });

  test.each<{ name: string; host: string; answer: { argv: string[]; stdout: string }; expected: unknown }>([
    {
      name: "gh answers for a github host",
      host: "github.com",
      answer: { argv: ["gh"], stdout: "MERGED\t12\n" },
      expected: { state: "MERGED", number: "12" },
    },
    {
      name: "glab answers for a gitlab host, and OPENED reads as OPEN",
      host: "gitlab.example.com",
      answer: { argv: ["glab"], stdout: '[{"state":"opened","iid":7}]' },
      expected: { state: "OPEN", number: "7" },
    },
  ])("prState: $name", ({ host, answer, expected }) => {
    expect(prState(fakeIo({ answers: [answer] }), "feature", host)).toEqual(expected);
  });

  test("prState is undefined when the forge CLI is absent", () => {
    expect(prState(fakeIo(), "feature", "github.com")).toBeUndefined();
  });
});
