import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";

const source = join(repoRoot, "macos", "tailgate-verify");
const leaf = "0123456789abcdef0123456789abcdef01234567";

let box: Sandbox;
let binary: string;

beforeEach(() => {
  box = sandbox("tailgate-verify");
  binary = box.write("tailgate", "");
});

afterEach(() => {
  box.remove();
});

// A copy of the script with the hash a case needs in place of the committed one.
function script(hash: string): string {
  const copy = box.write("tailgate-verify", readFileSync(source, "utf8").replace(/^leaf=.*$/m, `leaf=${hash}`));
  chmodSync(copy, 0o755);
  return copy;
}

function signedBy(hash: string): void {
  recordingStub(
    box,
    "codesign",
    `echo 'designated => identifier "dev.bendrucker.tailgate" and certificate leaf = H"${hash}"' >&2`,
  );
}

function verify(hash: string, options: { runsTailgate?: boolean; attested?: boolean } = {}) {
  if (options.runsTailgate) box.write("config/tailgate/tailgate.hujson", "{}");
  recordingStub(box, "gh", options.attested === false ? "exit 1" : "exit 0");
  return run([script(hash), binary], { path: [box.bin], env: { XDG_CONFIG_HOME: box.path("config") } });
}

function commands(): string[] {
  return recorded(box).map((call) => call[0]);
}

test("checks the release workflow's attestation on a machine that runs tailgate", () => {
  signedBy(leaf);

  const r = verify(leaf, { runsTailgate: true });

  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(recorded(box).at(-1)).toEqual([
    "gh",
    "attestation",
    "verify",
    binary,
    "--repo",
    "bendrucker/tailgate",
    "--signer-workflow",
    "bendrucker/tailgate/.github/workflows/release.yml",
  ]);
});

test("fails when the attestation doesn't verify", () => {
  signedBy(leaf);

  expect(verify(leaf, { runsTailgate: true, attested: false }).status).not.toBe(0);
});

test("checks only the signature where tailgate doesn't run", () => {
  signedBy(leaf);

  expect(verify(leaf).status).toBe(0);
  expect(commands()).toEqual(["codesign"]);
});

test.each<{ name: string; signer: string; scriptLeaf: string; message: string }>([
  { name: "a binary signed by another certificate", signer: "f".repeat(40), scriptLeaf: leaf, message: "expected" },
  { name: "an unset certificate hash", signer: leaf, scriptLeaf: "", message: "not set" },
])("fails on $name", ({ signer, scriptLeaf, message }) => {
  signedBy(signer);

  const r = verify(scriptLeaf, { runsTailgate: true });

  expect(r.status).toBe(1);
  expect(r.stderr).toContain(message);
  expect(commands()).not.toContain("gh");
});
