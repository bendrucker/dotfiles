import { describe, expect, test } from "bun:test";
import { dispose, pruneFlags, type AgentInfo, type DispositionInput, type PrInfo } from "./disposition";

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return { number: 1, conflicting: false, checks: "running", ...overrides };
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return { paneId: "p1", status: "idle", blockedToken: false, doneToken: false, ...overrides };
}

function makeInput(overrides: Partial<DispositionInput> = {}): DispositionInput {
  return { integrated: false, empty: false, agents: [], dirty: false, unpushed: 0, ignored: [], ...overrides };
}

describe("dispose", () => {
  test.each<{ name: string; input: DispositionInput; step: string; reason: string; pane?: string }>([
    {
      name: "an agent waiting on review leads with its kind",
      input: makeInput({ agents: [makeAgent({ review: { kind: "plan", summary: "approve the data plan" } })] }),
      step: "review",
      reason: "plan",
      pane: "p1",
    },
    {
      name: "a review with no kind still asks for you",
      input: makeInput({ agents: [makeAgent({ status: "blocked", review: {} })] }),
      step: "review",
      reason: "review",
      pane: "p1",
    },
    {
      name: "a review outranks a merged branch",
      input: makeInput({ integrated: true, agents: [makeAgent({ review: { kind: "code" } })] }),
      step: "review",
      reason: "code",
      pane: "p1",
    },
    { name: "integrated with no open PR prunes", input: makeInput({ integrated: true }), step: "prune", reason: "merged" },
    {
      name: "merged with a blocked agent still prunes",
      input: makeInput({ integrated: true, agents: [makeAgent({ status: "blocked" })] }),
      step: "prune",
      reason: "merged",
    },
    {
      name: "integrated content with an open PR waits for the PR",
      input: makeInput({ integrated: true, pr: makePr() }),
      step: "collapsed",
      reason: "checks running",
    },
    { name: "blocked status goes", input: makeInput({ agents: [makeAgent({ status: "blocked" })] }), step: "go", reason: "blocked" },
    { name: "blocked token goes", input: makeInput({ agents: [makeAgent({ blockedToken: true })] }), step: "go", reason: "blocked" },
    {
      name: "blocked outranks failing CI",
      input: makeInput({ pr: makePr({ checks: "failed" }), agents: [makeAgent({ status: "blocked" })] }),
      step: "go",
      reason: "blocked",
    },
    {
      name: "failing CI wakes an idle agent",
      input: makeInput({ pr: makePr({ checks: "failed" }), agents: [makeAgent()] }),
      step: "wake",
      reason: "CI failing",
      pane: "p1",
    },
    {
      name: "conflicts wake an idle agent",
      input: makeInput({ pr: makePr({ conflicting: true, checks: "passed" }), agents: [makeAgent()] }),
      step: "wake",
      reason: "conflicting",
      pane: "p1",
    },
    {
      name: "requested changes wake an idle agent",
      input: makeInput({ pr: makePr({ checks: "passed", review: "changes_requested" }), agents: [makeAgent()] }),
      step: "wake",
      reason: "changes requested",
      pane: "p1",
    },
    {
      name: "wakes the idle pane out of several",
      input: makeInput({
        pr: makePr({ checks: "failed" }),
        agents: [makeAgent({ paneId: "p1", status: "working" }), makeAgent({ paneId: "p2", status: "done" })],
      }),
      step: "wake",
      reason: "CI failing",
      pane: "p2",
    },
    {
      name: "failing CI with no agent needs you",
      input: makeInput({ pr: makePr({ checks: "failed" }) }),
      step: "go",
      reason: "CI failing",
    },
    {
      name: "failing CI under a working agent waits",
      input: makeInput({ pr: makePr({ checks: "failed" }), agents: [makeAgent({ status: "working" })] }),
      step: "collapsed",
      reason: "working",
    },
    {
      name: "failing CI outranks a done token",
      input: makeInput({ pr: makePr({ checks: "failed" }), agents: [makeAgent({ doneToken: true })] }),
      step: "wake",
      reason: "CI failing",
      pane: "p1",
    },
    { name: "done token goes", input: makeInput({ agents: [makeAgent({ doneToken: true })] }), step: "go", reason: "done" },
    {
      name: "green with an idle agent is ready to merge",
      input: makeInput({ pr: makePr({ checks: "passed" }), agents: [makeAgent()] }),
      step: "go",
      reason: "ready to merge",
    },
    { name: "no CI counts as green", input: makeInput({ pr: makePr({ checks: "no-ci" }) }), step: "go", reason: "ready to merge" },
    {
      name: "green but awaiting a required review",
      input: makeInput({ pr: makePr({ checks: "passed", review: "pending" }) }),
      step: "go",
      reason: "awaiting review",
    },
    {
      name: "green with a working agent is not ready",
      input: makeInput({ pr: makePr({ checks: "passed" }), agents: [makeAgent({ status: "working" })] }),
      step: "collapsed",
      reason: "working",
    },
    {
      name: "green draft is not ready",
      input: makeInput({ pr: makePr({ checks: "passed", review: "draft" }), agents: [makeAgent()] }),
      step: "collapsed",
      reason: "draft",
    },
    { name: "running checks collapse", input: makeInput({ pr: makePr(), agents: [makeAgent()] }), step: "collapsed", reason: "checks running" },
    { name: "unknown checks collapse", input: makeInput({ pr: makePr({ checks: "none" }) }), step: "collapsed", reason: "open PR" },
    { name: "a branch with no commits collapses", input: makeInput({ empty: true }), step: "collapsed", reason: "no commits" },
    { name: "no PR collapses", input: makeInput(), step: "collapsed", reason: "no PR" },
  ])("$name", ({ input, step, reason, pane }) => {
    const result = dispose(input);
    expect({ step: result.step, reason: result.reason, pane: result.pane }).toEqual({ step, reason, pane });
  });

  test("a review carries the agent's summary", () => {
    const result = dispose(makeInput({ agents: [makeAgent({ review: { kind: "pr-body", summary: "write the body" } })] }));
    expect(result.detail).toBe("write the body");
  });

  test("a working agent on a merged branch stays prune and is flagged live", () => {
    const result = dispose(makeInput({ integrated: true, agents: [makeAgent({ status: "working" })] }));
    expect(result).toEqual({ step: "prune", reason: "merged", flags: ["live"] });
  });

  test("non-prune dispositions carry no flags", () => {
    expect(dispose(makeInput({ dirty: true, unpushed: 2 })).flags).toEqual([]);
  });
});

describe("pruneFlags", () => {
  test.each([
    { name: "clean", input: makeInput(), flags: [] },
    { name: "live", input: makeInput({ agents: [makeAgent({ status: "working" })] }), flags: ["live"] },
    { name: "idle agent is not live", input: makeInput({ agents: [makeAgent()] }), flags: [] },
    { name: "dirty", input: makeInput({ dirty: true }), flags: ["dirty"] },
    { name: "unpushed", input: makeInput({ unpushed: 3 }), flags: ["unpushed:3"] },
    { name: "ignored", input: makeInput({ ignored: ["a/", "b"] }), flags: ["ignored:2"] },
    {
      name: "all together",
      input: makeInput({ agents: [makeAgent({ status: "working" })], dirty: true, unpushed: 1, ignored: ["x"] }),
      flags: ["live", "dirty", "unpushed:1", "ignored:1"],
    },
  ])("$name", ({ input, flags }) => {
    expect(pruneFlags(input)).toEqual(flags);
  });
});
