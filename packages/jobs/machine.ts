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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { type Io, readOk } from "#io";

// Long enough that two machines will not collide, short enough to sit in a marker
// line a human reads past.
const KEY_LENGTH = 8;

const PLATFORM_UUID = /"IOPlatformUUID"\s*=\s*"([^"]+)"/;

// systemd's per-installation id, which is the Linux counterpart to the hardware
// UUID. Nothing schedules these jobs on Linux, but CI runs their tests there and
// a key derived from a hostname CI reassigns per runner is not a key.
const MACHINE_ID = "/etc/machine-id";

export function machineName(io: Io): string {
  return capture(io, ["scutil", "--get", "ComputerName"]) || shortHostname();
}

// Hashed rather than used raw so the marker it lands in stays short and carries
// nothing about the hardware.
export function machineKey(io: Io): string {
  return createHash("sha1").update(machineIdentity(io)).digest("hex").slice(0, KEY_LENGTH);
}

function machineIdentity(io: Io): string {
  return platformUuid(io) || linuxMachineId() || shortHostname();
}

function platformUuid(io: Io): string {
  const ioreg = capture(io, ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
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
function capture(io: Io, cmd: string[]): string {
  return readOk(io, cmd, { stdin: "ignore", stderr: "ignore" })?.trim() ?? "";
}
