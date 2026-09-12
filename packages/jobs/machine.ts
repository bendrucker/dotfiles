// Which machine a nightly job is reporting from, resolved to something that does
// not move underneath a to-do.
//
// The short hostname moves. The MacBook answers `mac` on one network and
// `Ben-Druckers-MacBook-Pro` on another, so a to-do keyed on it files a second
// time for a cause already filed the moment the machine changes networks. That
// is half of why Today collected the same failure over and over.
//
// The two answers here are deliberately different. `machineName` is what a reader
// sees, so it is the name set in System Settings. `machineKey` is what the to-do
// is keyed on, so it is derived from the hardware, which no rename touches: the
// to-dos already filed against a machine have to keep matching it afterwards.

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

export function machineName(): string {
  return capture(["scutil", "--get", "ComputerName"]) || shortHostname();
}

// A stable, opaque identifier for this machine. Hashed rather than used raw so
// the marker it lands in stays short and carries nothing about the hardware.
export function machineKey(): string {
  return createHash("sha1").update(machineIdentity()).digest("hex").slice(0, KEY_LENGTH);
}

function machineIdentity(): string {
  return platformUuid() || linuxMachineId() || shortHostname();
}

function platformUuid(): string {
  const ioreg = capture(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
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

// Resolving the binary rather than reading process.platform is what lets a test
// put its own scutil on PATH, and it answers the question the call actually
// depends on. A command that is absent or fails yields the empty string, which
// every caller here reads as "ask the next source".
function capture(cmd: string[]): string {
  const binary = Bun.which(cmd[0], { PATH: process.env.PATH });
  if (!binary) return "";

  const child = Bun.spawnSync({
    cmd: [binary, ...cmd.slice(1)],
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return child.exitCode === 0 ? child.stdout.toString().trim() : "";
}
