import { describe, expect, test } from "bun:test";
import { type Answer, fakeIo } from "#harness";
import { machineKey, machineName } from "#jobs/machine";

const IOREG = ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"];

function platformUuid(uuid: string): Answer {
  return { argv: IOREG, stdout: `"IOPlatformUUID" = "${uuid}"\n` };
}

describe("machineName", () => {
  test("is the name macOS holds for the computer", () => {
    const io = fakeIo({ answers: [{ argv: ["scutil", "--get", "ComputerName"], stdout: "Mac Studio\n" }] });
    expect(machineName(io)).toBe("Mac Studio");
    expect(io.calls[0].options).toEqual({ stdin: "ignore", stderr: "ignore" });
  });

  test.each<{ name: string; answers: Answer[] }>([
    { name: "scutil is absent", answers: [] },
    { name: "scutil fails", answers: [{ argv: ["scutil"], status: 1 }] },
  ])("falls back to the hostname where $name", ({ answers }) => {
    expect(machineName(fakeIo({ answers }))).not.toBe("");
  });
});

// The MacBook answers `mac` on one network and `Ben-Druckers-MacBook-Pro` on
// another, which filed a second to-do for a cause already standing. The key has
// to survive that, and a rename of the computer too.
describe("machineKey", () => {
  test("is stable across two calls", () => {
    const io = fakeIo({ answers: [platformUuid("E1B2C3D4-0000-0000-0000-000000000001")] });
    expect(machineKey(io)).toBe(machineKey(io));
  });

  test("separates two machines", () => {
    const studio = machineKey(fakeIo({ answers: [platformUuid("AAAA0000-0000-0000-0000-000000000001")] }));
    const laptop = machineKey(fakeIo({ answers: [platformUuid("BBBB0000-0000-0000-0000-000000000002")] }));
    expect(laptop).not.toBe(studio);
  });

  test("does not move when the computer is renamed", () => {
    const uuid = platformUuid("AAAA0000-0000-0000-0000-000000000001");
    const before = machineKey(fakeIo({ answers: [uuid, { argv: ["scutil"], stdout: "Old Name\n" }] }));
    const after = machineKey(fakeIo({ answers: [uuid, { argv: ["scutil"], stdout: "New Name\n" }] }));
    expect(after).toBe(before);
  });

  test("is opaque, carrying nothing of the hardware identifier", () => {
    const key = machineKey(fakeIo({ answers: [platformUuid("AAAA0000-0000-0000-0000-000000000001")] }));
    expect(key).not.toContain("AAAA");
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  test("still answers where neither source is available", () => {
    expect(machineKey(fakeIo())).toMatch(/^[0-9a-f]{8}$/);
  });
});
