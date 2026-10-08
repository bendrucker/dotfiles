import { describe, expect, test } from "bun:test";
import {
  dispose,
  pruneFlags,
  type AgentInfo,
  type DispositionInput,
  type PrInfo,
} from "./disposition";


function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 1,
    state: "OPEN",
    draft: false,
    conflicting: false,
    checks: "pending",
    updated: "2026-10-07T10:00:00Z",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return { paneId: "p1", status: "idle", blockedToken: false, doneToken: false, ...overrides };
}

function makeInput(overrides: Partial<DispositionInput> = {}): DispositionInput {
  return { prs: [], agents: [], lastWorked: {}, dirty: false, unpushed: 0, ignored: [], ...overrides };
}

const before = Date.parse("2026-10-07T09:00:00Z");
const after = Date.parse("2026-10-07T11:00:00Z");

describe("dispose", () => {
  test.each([
    {
      name: "merged PR prunes",
      input: makeInput({ prs: [makePr({ state: "MERGED" })] }),
      step: "prune",
      reason: "merged",
    },
    {
      name: "newest PR closed prunes",
      input: makeInput({ prs: [makePr({ state: "CLOSED" })] }),
      step: "prune",
      reason: "closed",
    },
    {
      name: "older merged beats newer closed",
      input: makeInput({
        prs: [makePr({ number: 1, state: "MERGED" }), makePr({ number: 2, state: "CLOSED", updated: "2026-10-07T11:00:00Z" })],
      }),
      step: "prune",
      reason: "merged",
    },
    {
      name: "merged with a blocked agent still prunes",
      input: makeInput({ prs: [makePr({ state: "MERGED" })], agents: [makeAgent({ status: "blocked" })] }),
      step: "prune",
      reason: "merged",
    },
    {
      name: "an open PR alongside a merged one does not prune",
      input: makeInput({ prs: [makePr({ number: 1, state: "MERGED" }), makePr({ number: 2, checks: "pending" })] }),
      step: "collapsed",
      reason: "checks pending",
    },
    {
      name: "blocked status goes",
      input: makeInput({ agents: [makeAgent({ status: "blocked" })] }),
      step: "go",
      reason: "blocked",
    },
    {
      name: "blocked token goes",
      input: makeInput({ agents: [makeAgent({ blockedToken: true })] }),
      step: "go",
      reason: "blocked",
    },
    {
      name: "done token goes",
      input: makeInput({ agents: [makeAgent({ doneToken: true })] }),
      step: "go",
      reason: "done, review",
    },
    {
      name: "failing checks go",
      input: makeInput({ prs: [makePr({ checks: "fail" })] }),
      step: "go",
      reason: "CI failing",
    },
    {
      name: "conflicting goes",
      input: makeInput({ prs: [makePr({ conflicting: true, checks: "ok" })] }),
      step: "go",
      reason: "conflicting",
    },
    {
      name: "green non-draft with an idle agent is ready to merge",
      input: makeInput({ prs: [makePr({ checks: "ok" })], agents: [makeAgent()] }),
      step: "go",
      reason: "ready to merge",
    },
    {
      name: "green non-draft with no agent is ready to merge",
      input: makeInput({ prs: [makePr({ checks: "ok" })] }),
      step: "go",
      reason: "ready to merge",
    },
    {
      name: "blocked outranks failing CI",
      input: makeInput({ prs: [makePr({ checks: "fail" })], agents: [makeAgent({ status: "blocked" })] }),
      step: "go",
      reason: "blocked",
    },
    {
      name: "failing CI outranks done token",
      input: makeInput({ prs: [makePr({ checks: "fail" })], agents: [makeAgent({ doneToken: true })] }),
      step: "go",
      reason: "CI failing",
    },
    {
      name: "green PR with a working agent is not ready",
      input: makeInput({ prs: [makePr({ checks: "ok" })], agents: [makeAgent({ status: "working" })] }),
      step: "collapsed",
      reason: "working",
    },
    {
      name: "green draft is not ready",
      input: makeInput({ prs: [makePr({ checks: "ok", draft: true })], agents: [makeAgent()] }),
      step: "collapsed",
      reason: "draft",
    },
    {
      name: "pending checks collapse",
      input: makeInput({ prs: [makePr()], agents: [makeAgent()] }),
      step: "collapsed",
      reason: "checks pending",
    },
    {
      name: "no PR and no agents collapses",
      input: makeInput(),
      step: "collapsed",
      reason: "no PR",
    },
    {
      name: "unknown checks with no signal collapse",
      input: makeInput({ prs: [makePr({ checks: "none" })], agents: [makeAgent()] }),
      step: "collapsed",
      reason: "open PR",
    },
  ])("$name", ({ input, step, reason }) => {
    const result = dispose(input);
    expect({ step: result.step, reason: result.reason }).toEqual({ step, reason });
  });

  test.each([
    {
      name: "PR updated after the agent last worked wakes it",
      input: makeInput({ prs: [makePr()], agents: [makeAgent()], lastWorked: { p1: before } }),
      step: "wake",
      pane: "p1",
    },
    {
      name: "PR older than last work does not wake",
      input: makeInput({ prs: [makePr()], agents: [makeAgent()], lastWorked: { p1: after } }),
      step: "collapsed",
      pane: undefined,
    },
    {
      name: "a pane with no recorded work is not woken",
      input: makeInput({ prs: [makePr()], agents: [makeAgent()] }),
      step: "collapsed",
      pane: undefined,
    },
    {
      name: "a working agent is not woken",
      input: makeInput({ prs: [makePr()], agents: [makeAgent({ status: "working" })], lastWorked: { p1: before } }),
      step: "collapsed",
      pane: undefined,
    },
    {
      name: "picks the idle pane out of several",
      input: makeInput({
        prs: [makePr()],
        agents: [makeAgent({ paneId: "p1", status: "working" }), makeAgent({ paneId: "p2" })],
        lastWorked: { p1: before, p2: before },
      }),
      step: "wake",
      pane: "p2",
    },
    {
      name: "skips a pane that worked after the update",
      input: makeInput({
        prs: [makePr()],
        agents: [makeAgent({ paneId: "p1" }), makeAgent({ paneId: "p2", status: "done" })],
        lastWorked: { p1: after, p2: before },
      }),
      step: "wake",
      pane: "p2",
    },
    {
      name: "go outranks wake",
      input: makeInput({ prs: [makePr({ checks: "fail" })], agents: [makeAgent()], lastWorked: { p1: before } }),
      step: "go",
      pane: undefined,
    },
  ])("wake: $name", ({ input, step, pane }) => {
    const result = dispose(input);
    expect({ step: result.step, pane: result.pane }).toEqual({ step, pane });
  });

  test("a working agent on a merged branch stays prune and is flagged live", () => {
    const result = dispose(
      makeInput({ prs: [makePr({ state: "MERGED" })], agents: [makeAgent({ status: "working" })] }),
    );
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
      input: makeInput({
        agents: [makeAgent({ status: "working" })],
        dirty: true,
        unpushed: 1,
        ignored: ["x"],
      }),
      flags: ["live", "dirty", "unpushed:1", "ignored:1"],
    },
  ])("$name", ({ input, flags }) => {
    expect(pruneFlags(input)).toEqual(flags);
  });
});
