import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";

const script = join(repoRoot, "macos", "tailgate", "sign");
const leaf = "0123456789abcdef0123456789abcdef01234567";

let box: Sandbox;
let keychain: string;
let binary: string;

beforeEach(() => {
  box = sandbox("tailgate-sign");
  keychain = box.path("home", "Library", "Keychains", "tailgate-signing.keychain-db");
  binary = box.write("tailgate", "");
  box.stub("uname", "echo Darwin");
  recordingStub(
    box,
    "security",
    `[ "$1" = find-certificate ] && echo "SHA-1 hash: ${leaf.toUpperCase()}"\nexit 0`,
  );
  codesignReports(leaf);
});

afterEach(() => {
  box.remove();
});

function codesignReports(hash: string): void {
  recordingStub(
    box,
    "codesign",
    `[ "$1" = --display ] && echo 'designated => identifier "dev.bendrucker.tailgate" and certificate leaf = H"${hash}"' >&2\nexit 0`,
  );
}

function runsTailgate(): void {
  box.write("config/tailgate/tailgate.hujson", "{}");
}

function sign(env: Record<string, string> = {}) {
  return run([script, binary], {
    path: [box.bin],
    env: { HOME: box.path("home"), XDG_CONFIG_HOME: box.path("config"), TAILGATE_SIGN_TTY: "/dev/null", ...env },
  });
}

function commands(): string[] {
  return recorded(box).map((call) => `${call[0]} ${call[1]}`);
}

test("signs, verifies, and locks the keychain again", () => {
  runsTailgate();
  box.write("home/Library/Keychains/tailgate-signing.keychain-db", "");

  const r = sign();

  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(commands()).toEqual([
    "security unlock-keychain",
    "security find-certificate",
    "codesign --force",
    "codesign --display",
    "security lock-keychain",
  ]);
  expect(recorded(box)[2]).toEqual([
    "codesign",
    "--force",
    "--keychain",
    keychain,
    "--sign",
    "tailgate Code Signing",
    "--identifier",
    "dev.bendrucker.tailgate",
    binary,
  ]);
});

test("fails on a requirement naming another certificate", () => {
  runsTailgate();
  box.write("home/Library/Keychains/tailgate-signing.keychain-db", "");
  codesignReports("f".repeat(40));

  const r = sign();

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("expected 'designated => identifier");
  expect(commands().at(-1)).toBe("security lock-keychain");
});

test.each<{ name: string; keychain: boolean; tty: boolean; message: string }>([
  { name: "without the signing keychain", keychain: false, tty: true, message: "create-identity" },
  { name: "without a terminal to unlock the keychain on", keychain: true, tty: false, message: "needs a terminal" },
])("fails $name before touching the keychain", ({ keychain: present, tty, message }) => {
  runsTailgate();
  if (present) box.write("home/Library/Keychains/tailgate-signing.keychain-db", "");

  const r = sign({ TAILGATE_SIGN_TTY: tty ? "/dev/null" : box.path("no-tty") });

  expect(r.status).toBe(1);
  expect(r.stderr).toContain(message);
  expect(recorded(box)).toEqual([]);
});

test.each<{ name: string; os: string; config: boolean }>([
  { name: "a Mac that does not run tailgate", os: "Darwin", config: false },
  { name: "Linux", os: "Linux", config: true },
])("does nothing on $name", ({ os, config }) => {
  if (config) runsTailgate();
  box.stub("uname", `echo ${os}`);

  const r = sign();

  expect(r.status).toBe(0);
  expect(recorded(box)).toEqual([]);
});
