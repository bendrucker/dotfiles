import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineKey, machineName } from "#jobs/machine";

let sandbox: string;
let stubs: string;
const path = process.env.PATH;

function writeStub(name: string, body: string): void {
  const file = join(stubs, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "jobs-machine-"));
  stubs = join(sandbox, "stub");
  mkdirSync(stubs);
  process.env.PATH = stubs;
});

afterEach(() => {
  process.env.PATH = path;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("machineName", () => {
  test("is the name macOS holds for the computer", () => {
    writeStub("scutil", 'printf "Mac Studio\\n"');
    expect(machineName()).toBe("Mac Studio");
  });

  test.each<{ name: string; stub?: string }>([
    { name: "scutil is absent" },
    { name: "scutil fails", stub: "exit 1" },
  ])("falls back to the hostname where $name", ({ stub }) => {
    if (stub) writeStub("scutil", stub);
    expect(machineName()).not.toBe("");
  });
});

// The MacBook answers `mac` on one network and `Ben-Druckers-MacBook-Pro` on
// another, which filed a second to-do for a cause already standing. The key has
// to survive that, and a rename of the computer too.
describe("machineKey", () => {
  test("is stable across two calls", () => {
    writeStub("ioreg", 'printf \'"IOPlatformUUID" = "E1B2C3D4-0000-0000-0000-000000000001"\\n\'');
    expect(machineKey()).toBe(machineKey());
  });

  test("separates two machines", () => {
    writeStub("ioreg", 'printf \'"IOPlatformUUID" = "AAAA0000-0000-0000-0000-000000000001"\\n\'');
    const studio = machineKey();
    writeStub("ioreg", 'printf \'"IOPlatformUUID" = "BBBB0000-0000-0000-0000-000000000002"\\n\'');
    expect(machineKey()).not.toBe(studio);
  });

  test("does not move when the computer is renamed", () => {
    writeStub("ioreg", 'printf \'"IOPlatformUUID" = "AAAA0000-0000-0000-0000-000000000001"\\n\'');
    writeStub("scutil", 'printf "Old Name\\n"');
    const before = machineKey();
    writeStub("scutil", 'printf "New Name\\n"');
    expect(machineKey()).toBe(before);
  });

  test("is opaque, carrying nothing of the hardware identifier", () => {
    writeStub("ioreg", 'printf \'"IOPlatformUUID" = "AAAA0000-0000-0000-0000-000000000001"\\n\'');
    expect(machineKey()).not.toContain("AAAA");
    expect(machineKey()).toMatch(/^[0-9a-f]{8}$/);
  });

  test("still answers where neither source is available", () => {
    expect(machineKey()).toMatch(/^[0-9a-f]{8}$/);
  });
});
