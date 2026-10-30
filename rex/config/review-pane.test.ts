import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "rex", "config", "review-pane");
const agent = "block:agent";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("rex-review-pane");
  box.stub("tuicr", `printf '%s\\n' "$@" > ${quote(box.path("tuicr-args"))}\nprintf '%s' "$REVIEW"`);
  box.stub("rex", `for arg in "$@"; do printf '%s\\0' "$arg"; done > ${quote(box.path("rex-args"))}`);
});

afterEach(() => {
  box.remove();
});

function rexArgs(): string[] {
  return box.read("rex-args").split("\0").slice(0, -1);
}

describe("rex/config/review-pane", () => {
  test("passes its other arguments to tuicr with --stdout", () => {
    run([script, agent, "--working-tree"], { path: [box.bin], env: { REVIEW: "" } });
    expect(box.read("tuicr-args")).toBe("--stdout\n--working-tree\n");
  });

  test.each<{ name: string; review: string; args: string[] }>([
    {
      name: "pastes an exported review into the agent and focuses it",
      review: "1. `f:1` - rename\nthis",
      args: [`block=${agent}`, "text=1. `f:1` - rename\nthis"],
    },
    { name: "only focuses the agent when nothing was exported", review: "", args: [`block=${agent}`] },
  ])("$name", ({ review, args }) => {
    const result = run([script, agent], { path: [box.bin], env: { REVIEW: review } });

    expect(result.status).toBe(0);
    const [command, flag, lua, ...rest] = rexArgs();
    expect([command, flag]).toEqual(["do", "-e"]);
    expect(lua).toContain('type = "paste"');
    expect(rest).toEqual(args);
  });

  test.each<{ name: string; fails: string; shows: string }>([
    { name: "tuicr", fails: "tuicr", shows: "tuicr exited 3." },
    { name: "the hand-back", fails: "rex", shows: "1. rename\n\nHanding this review to block:agent failed." },
  ])("holds the pane open with the review when $name fails", ({ fails, shows }) => {
    box.stub(fails, "exit 3");
    const result = run([script, agent], { path: [box.bin], env: { REVIEW: "1. rename" } });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${shows} Press Enter to close.\n`);
  });
});
