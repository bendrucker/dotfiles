// Which machine a nightly job is reporting from, resolved to something that does
// not move underneath a to-do.
//
// The short hostname moves. The MacBook answers `mac` on one network and
// `Ben-Druckers-MacBook-Pro` on another, so a to-do keyed on it files a second
// time for a cause already filed the moment the machine changes networks.
//
// The two answers here are deliberately different. `machineName` is what a reader
// sees, so it is the name set in System Settings. `machineKey` is what the to-do
// is keyed on, so it is derived from the hardware, which no rename touches: the
// to-dos already filed against a machine have to keep matching it afterwards.

import { $ } from "bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

// Long enough that two machines will not collide, short enough to sit in a marker
// line a human reads past.
const KEY_LENGTH = 8;

const PLATFORM_UUID = /"IOPlatformUUID"\s*=\s*"([^"]+)"/;

// systemd's per-installation id, which is the Linux counterpart to the hardware
// UUID. Nothing schedules these jobs on Linux, but CI runs their tests there and
// a key derived from a hostname CI reassigns per runner is not a key.
const MACHINE_ID = "/etc/machine-id";

export async function machineName(): Promise<string> {
  return (await capture(["scutil", "--get", "ComputerName"])) || shortHostname();
}

// Hashed rather than used raw so the marker it lands in stays short and carries
// nothing about the hardware.
export async function machineKey(): Promise<string> {
  return createHash("sha1").update(await machineIdentity()).digest("hex").slice(0, KEY_LENGTH);
}

async function machineIdentity(): Promise<string> {
  return (await platformUuid()) || linuxMachineId() || shortHostname();
}

async function platformUuid(): Promise<string> {
  const ioreg = await capture(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
  return ioreg.match(PLATFORM_UUID)?.[1] ?? "";
}

function linuxMachineId(): string {
  try {
    return readFileSync(MACHINE_ID, "utf8").trim();
  } catch {
    return "";
  }
}

function shortHostname(): string {
  return hostname().split(".")[0];
}

// An absent or failing command yields the empty string, which every caller here
// reads as "ask the next source".
async function capture(cmd: string[]): Promise<string> {
  const result = await $`${cmd} < /dev/null`.nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}
