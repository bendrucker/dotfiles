import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sandbox, type Sandbox } from "#harness";
import { capture, defaultBranch, listWorktrees, prState, remoteHost } from "./state.ts";

let box: Sandbox;
let originalPath: string | undefined;

beforeEach(() => {
  box = sandbox("state");
  originalPath = process.env.PATH;
  process.env.PATH = `${box.bin}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  box.remove();
});

describe("capture", () => {
  test("trims trailing newlines", async () => {
    box.stub("tool", 'printf "value\\n\\n"');
    expect(await capture(["tool"])).toBe("value");
  });

  test("closes stdin", async () => {
    box.stub("tool", "cat; printf done");
    expect(await capture(["tool"])).toBe("done");
  });

  test("keeps what a failing command printed", async () => {
    box.stub("tool", 'printf "partial\\n"; exit 1');
    expect(await capture(["tool"])).toBe("partial");
  });

  test("is empty for a command that is not installed", async () => {
    expect(await capture(["not-installed-here"])).toBe("");
  });
});

describe("readers over capture", () => {
  test("defaultBranch is empty when wt cannot be run", async () => {
    process.env.PATH = box.bin;
    expect(await defaultBranch()).toBe("");
  });

  test("remoteHost reads the host out of the configured url", async () => {
    box.stub("git", 'printf "git@github.com:o/r.git\\n"');
    expect(await remoteHost()).toBe("github.com");
  });

  test("listWorktrees is undefined when wt says nothing", async () => {
    box.stub("wt", "exit 0");
    expect(await listWorktrees()).toBeUndefined();
  });

  test.each<{ name: string; host: string; tool: string; stdout: string; expected: unknown }>([
    {
      name: "gh answers for a github host",
      host: "github.com",
      tool: "gh",
      stdout: "MERGED\\t12\\n",
      expected: { state: "MERGED", number: "12" },
    },
    {
      name: "glab answers for a gitlab host, and OPENED reads as OPEN",
      host: "gitlab.example.com",
      tool: "glab",
      stdout: '[{"state":"opened","iid":7}]',
      expected: { state: "OPEN", number: "7" },
    },
  ])("prState: $name", async ({ host, tool, stdout, expected }) => {
    box.stub(tool, `printf '${stdout}'`);
    expect(await prState("feature", host)).toEqual(expected);
  });

  test("prState is undefined when the forge CLI is absent", async () => {
    process.env.PATH = box.bin;
    expect(await prState("feature", "github.com")).toBeUndefined();
  });
});
