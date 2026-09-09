import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";

const withSecrets = join(repoRoot, "credentials", "bin", "with-secrets");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("with-secrets");
  box.mkdir("env");
});

afterEach(() => {
  box.remove();
});

function runWith(args: string[], options: { path?: string[] } = {}): Run {
  return run([withSecrets, ...args], {
    env: { CREDENTIALS_ENV_DIR: box.path("env") },
    path: options.path ?? [box.bin],
  });
}

function stubTool(name: string): void {
  box.stub(name, `echo "${name} $* token=\${DEMO_TOKEN-unset}"`);
}

// Stands in for op run, which passes the command through with the referenced
// values resolved into its environment.
function stubOp(): void {
  box.stub(
    "op",
    [
      `echo "op $*" >> ${box.path("op.calls")}`,
      // `op run --env-file=X -- cmd args`: drop everything up to the separator.
      'while [ "$1" != "--" ]; do shift; done',
      "shift",
      'DEMO_TOKEN=resolved exec "$@"',
    ].join("\n"),
  );
}

test("runs a command with nothing added when no env file names it", () => {
  stubTool("npm");
  stubOp();

  const result = runWith(["npm", "publish"]);
  expect(result.stdout.trim()).toBe("npm publish token=unset");
  // Nothing to inject means nothing to ask 1Password for.
  expect(box.read("op.calls")).toBe("");
});

test("resolves the secrets its env file names for that one command", () => {
  box.write("env/npm.env", "DEMO_TOKEN=op://Testing/npm/token\n");
  stubTool("npm");
  stubOp();

  const result = runWith(["npm", "publish"]);
  expect(result.stdout.trim()).toBe("npm publish token=resolved");
  expect(box.read("op.calls").trim()).toBe(
    `op run --env-file=${box.path("env", "npm.env")} -- npm publish`,
  );
});

test("selects the env file by the command's own name, not the path it was given", () => {
  box.write("env/npm.env", "DEMO_TOKEN=op://Testing/npm/token\n");
  stubTool("npm");
  stubOp();

  expect(runWith([box.path("bin", "npm"), "publish"]).stdout).toContain("token=resolved");
});

// The name is what picks the profile, so a binary that merely borrows the name
// would otherwise be handed the token the real one gets.
test("withholds the secrets from a lookalike at another path", () => {
  box.write("env/npm.env", "DEMO_TOKEN=op://Testing/npm/token\n");
  stubTool("npm");
  stubOp();
  const impostor = box.write("elsewhere/npm", '#!/bin/sh\necho "npm $* token=${DEMO_TOKEN-unset}"\n');
  chmodSync(impostor, 0o755);

  const result = runWith([impostor, "publish"]);
  expect(result.stdout).toContain("token=unset");
  expect(result.stderr).toContain("is not the npm on PATH");
  expect(box.read("op.calls")).toBe("");
});

test("runs the command plainly where op is not installed", () => {
  box.write("env/npm.env", "DEMO_TOKEN=op://Testing/npm/token\n");
  stubTool("npm");

  // A fresh machine and CI, where credentials/Brewfile has not been installed.
  const result = run([withSecrets, "npm", "publish"], {
    env: { CREDENTIALS_ENV_DIR: box.path("env") },
    // bun itself still has to resolve, since the shebang finds it on PATH.
    onlyPath: [box.bin, dirname(process.execPath)],
  });
  expect(result.stdout.trim()).toBe("npm publish token=unset");
  expect(result.stderr).toContain("op is not installed");
});

test("carries the command's exit status back", () => {
  box.stub("failing", "exit 3");
  expect(runWith(["failing"]).status).toBe(3);
});

test("carries op's own failure rather than retrying without it", () => {
  box.write("env/npm.env", "DEMO_TOKEN=op://Testing/npm/token\n");
  stubTool("npm");
  // A locked Mac, where 1Password refuses to unlock. Running npm anyway would
  // turn that into an unauthenticated 401 with nothing pointing back here.
  box.stub("op", "echo 'could not connect' >&2\nexit 1");

  const result = runWith(["npm", "publish"]);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("npm publish");
});

test("reports a command that does not exist", () => {
  const result = runWith(["definitely-not-installed"]);
  expect(result.status).toBe(127);
  expect(result.stderr).toContain("definitely-not-installed");
});

test("asks for a command when given none", () => {
  const result = runWith([]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Usage:");
});
