import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";

const audit = join(repoRoot, "credentials", "bin", "credential-audit");

// Shaped like an npm token and worth nothing. Every fixture here is a literal
// this repo invented, so a test failure never prints somebody's credential.
const FAKE_NPM_TOKEN = "npm_000000000000000000000000000000000000";

// The ciphername and kdfname of "none", which is what an unencrypted OpenSSH
// key carries and an encrypted one does not.
const UNENCRYPTED_MARKER = "AAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";

// The header is assembled rather than written out so gitleaks reads these
// fixtures as the invented strings they are.
const pem = (kind: string, body: string) => `-----BEGIN ${kind} PRIVATE KEY-----\n${body}\n`;

let box: Sandbox;

beforeEach(() => {
  box = sandbox("credential-audit");
  box.mkdir("home");
});

afterEach(() => {
  box.remove();
});

function home(...parts: string[]): string {
  return box.path("home", ...parts);
}

// A credential file as a tool would leave it. The sandbox writes at the ambient
// umask, which is group-readable, and every test but the mode ones would then
// be reading a report about that instead of about what it set up.
function credential(name: string, contents: string): string {
  const path = box.write(name, contents);
  chmodSync(path, 0o600);
  return path;
}

function runAudit(args: string[] = [], env: Record<string, string> = {}): Run {
  return run([audit, ...args], {
    env: { HOME: home(), CREDENTIALS_ENV_DIR: box.path("env"), ...env },
    path: [box.bin],
  });
}

function verdicts(output: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/[ \t]+/);
    if (fields.length > 1) rows[fields[0]] = fields[1];
  }
  return rows;
}

describe("reporting", () => {
  test("says nothing about a home with no credentials in it", () => {
    const result = runAudit();
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  test.each<{ name: string; path: string; contents: string }>([
    {
      name: "an npmrc that references a variable",
      path: "home/.npmrc",
      contents: "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    },
    {
      name: "the registry config around the token",
      path: "home/.npmrc",
      contents: "@scope:registry=https://registry.example.com/\n",
    },
    {
      name: "a docker config that defers to a credential store",
      path: "home/.docker/config.json",
      contents: JSON.stringify({ auths: { "https://index.docker.io/v1/": {} }, credsStore: "desktop" }),
    },
    {
      name: "a gh config that keeps its token in the keychain",
      path: "home/.config/gh/hosts.yml",
      contents: "github.com:\n    git_protocol: ssh\n    user: someone\n",
    },
  ])("stays quiet about $name", ({ path, contents }) => {
    credential(path, contents);
    expect(runAudit().stdout).toBe("");
  });

  test.each<{ name: string; path: string; contents: string; subject: string }>([
    {
      name: "an npmrc holding a literal token",
      path: "home/.npmrc",
      contents: `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`,
      subject: "~/.npmrc",
    },
    {
      name: "a docker config carrying its own registry credential",
      path: "home/.docker/config.json",
      contents: JSON.stringify({ auths: { "registry.example.com": { auth: "aGk6dGhlcmU=" } } }),
      subject: "~/.docker/config.json",
    },
    {
      name: "a gh config carrying an oauth token",
      path: "home/.config/gh/hosts.yml",
      contents: "github.com:\n    oauth_token: gho_xxx\n",
      subject: "~/.config/gh/hosts.yml",
    },
    {
      name: "a token scoped to a registry naming a port",
      path: "home/.npmrc",
      contents: `//registry.example.com:8080/:_authToken=${FAKE_NPM_TOKEN}\n`,
      subject: "~/.npmrc",
    },
    {
      // Docker not being able to read the file is no reason to believe the
      // credential left it.
      name: "a docker config too truncated to parse",
      path: "home/.docker/config.json",
      contents: '{"auths":{"registry.example.com":{"auth":"aGk6dGhlcmU="',
      subject: "~/.docker/config.json",
    },
  ])("names $name", ({ path, contents, subject }) => {
    credential(path, contents);
    expect(verdicts(runAudit().stdout)).toEqual({ [subject]: "plaintext" });
  });

  test("tells an unencrypted private key from a passphrased one", () => {
    credential("home/.ssh/id_open", pem("OPENSSH", UNENCRYPTED_MARKER));
    credential("home/.ssh/id_locked", pem("OPENSSH", "b3BlbnNzaC1r"));
    expect(verdicts(runAudit().stdout)).toMatchObject({
      "~/.ssh/id_open": "unencrypted",
      "~/.ssh/id_locked": "passphrased",
    });
  });

  // The OpenSSH marker says nothing about a PEM key, so testing for it alone
  // reported every legacy key as protected whether or not it was.
  test("tells an unencrypted legacy key from an encrypted one", () => {
    credential("home/.ssh/id_pem", pem("RSA", "MIIEpAIBAAKC"));
    credential(
      "home/.ssh/id_pem_locked",
      pem("RSA", "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0000\n\nMIIEpAIBAAKC"),
    );
    credential("home/.ssh/id_pkcs8_locked", pem("ENCRYPTED", "MIIFHzBJ"));
    expect(verdicts(runAudit().stdout)).toMatchObject({
      "~/.ssh/id_pem": "unencrypted",
      "~/.ssh/id_pem_locked": "passphrased",
      "~/.ssh/id_pkcs8_locked": "passphrased",
    });
  });

  // Dropping it at the glob would take it out of the report altogether, and an
  // empty report is what clears the latch on a key that is still sitting there.
  test("holds an ssh key it cannot read rather than dropping it", () => {
    const path = credential("home/.ssh/id_unreadable", pem("OPENSSH", ""));
    chmodSync(path, 0o000);
    expect(verdicts(runAudit().stdout)["~/.ssh/id_unreadable"]).toBe("unreadable");
  });

  test("leaves the public half of a key alone", () => {
    credential("home/.ssh/id_ed25519.pub", "ssh-ed25519 AAAAC3Nza someone\n");
    expect(runAudit().stdout).toBe("");
  });
});

describe("modes", () => {
  test("names a credential file readable beyond its owner", () => {
    chmodSync(box.write("home/.config/gh/hosts.yml", "github.com:\n"), 0o644);
    expect(verdicts(runAudit().stdout)["~/.config/gh/hosts.yml"]).toBe("open");
  });

  test("--enforce tightens it and says so on stderr", () => {
    const path = box.write("home/.config/gh/hosts.yml", "github.com:\n");
    chmodSync(path, 0o644);

    const result = runAudit(["--enforce"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result.stderr).toContain("chmod 600 ~/.config/gh/hosts.yml");
    // The mode is fixed, so the report the nightly job files has nothing left
    // to say about it.
    expect(result.stdout).toBe("");
  });

  test("--enforce still reports a secret it cannot chmod away", () => {
    chmodSync(box.write("home/.npmrc", `_authToken=${FAKE_NPM_TOKEN}\n`), 0o644);
    expect(verdicts(runAudit(["--enforce"]).stdout)["~/.npmrc"]).toBe("plaintext");
  });

  test("leaves the mode of a symlinked credential alone", () => {
    // A chmod follows the link and would land on the tracked file in whatever
    // config repo it points into.
    const target = box.write("repo/hosts.yml", "github.com:\n");
    chmodSync(target, 0o644);
    box.mkdir("home/.config/gh");
    symlinkSync(target, home(".config", "gh", "hosts.yml"));

    expect(runAudit(["--enforce"]).stdout).toBe("");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  // Skipping the link altogether reported a secret readable at that path as no
  // finding at all, which is the one answer the nightly latch acts on.
  test("names a symlinked credential whose target holds a secret", () => {
    const target = box.write("repo/hosts.yml", "github.com:\n    oauth_token: gho_xxx\n");
    chmodSync(target, 0o644);
    box.mkdir("home/.config/gh");
    symlinkSync(target, home(".config", "gh", "hosts.yml"));

    expect(verdicts(runAudit(["--enforce"]).stdout)["~/.config/gh/hosts.yml"]).toBe("plaintext");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

describe("--adopt", () => {
  const REFERENCE = "op://Testing/npm/token";

  function declareReference(): void {
    box.write("env/npm.env", `NPM_TOKEN=${REFERENCE}\n`);
  }

  // Records the arguments so a test can show nothing else was asked for.
  function stubOp(value: string, status = 0): void {
    box.stub(
      "op",
      [
        `echo "$@" >> ${box.path("op.calls")}`,
        `[ "$1" = read ] || exit 9`,
        `printf '%s\\n' ${JSON.stringify(value)}`,
        `exit ${status}`,
      ].join("\n"),
    );
  }

  test("rewrites the token to a variable once 1Password hands back the same value", () => {
    declareReference();
    stubOp(FAKE_NPM_TOKEN);
    const path = credential(
      "home/.npmrc",
      `@scope:registry=https://registry.example.com/\n//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`,
    );

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(0);
    expect(box.read("op.calls").trim()).toBe(`read ${REFERENCE}`);
    // The registry line is npm's config rather than a secret, and survives.
    expect(box.read("home/.npmrc")).toBe(
      "@scope:registry=https://registry.example.com/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The rewrite goes through a neighbouring file and a rename, which must not
    // leave the neighbour behind.
    expect(existsSync(`${path}.credential-audit`)).toBe(false);
  });

  test("refuses when the item holds a different value", () => {
    declareReference();
    stubOp("npm_111111111111111111111111111111111111");
    const contents = `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`;
    credential("home/.npmrc", contents);

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds a different value");
    // The value it would have replaced is the only copy left, so it stays.
    expect(box.read("home/.npmrc")).toBe(contents);
    expect(result.stderr).not.toContain(FAKE_NPM_TOKEN);
  });

  test("refuses when 1Password cannot be read", () => {
    declareReference();
    box.stub("op", "echo 'not signed in' >&2\nexit 1");
    const contents = `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`;
    credential("home/.npmrc", contents);

    expect(runAudit(["--adopt"]).status).toBe(1);
    expect(box.read("home/.npmrc")).toBe(contents);
  });

  test("refuses when no reference is declared for the variable", () => {
    box.write("env/npm.env", "# nothing declared yet\n");
    stubOp(FAKE_NPM_TOKEN);
    credential("home/.npmrc", `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`);

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names no NPM_TOKEN reference");
  });

  // The stub stands in for the unlock prompt, which waits on a person. Anything
  // npm writes while it is open would be rolled back by a rewrite of the older
  // snapshot, so the file is re-read and compared before it is replaced.
  test("refuses when the file changed while 1Password was unlocking", () => {
    declareReference();
    const path = credential("home/.npmrc", `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`);
    box.stub(
      "op",
      [
        `printf '%s\\n' "@scope:registry=https://added.example.com/" >> ${path}`,
        `printf '%s\\n' ${JSON.stringify(FAKE_NPM_TOKEN)}`,
      ].join("\n"),
    );

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed while 1Password was unlocking");
    // What the other writer added is still there, and the token it was holding
    // was not swapped for a reference behind its back.
    expect(box.read("home/.npmrc")).toContain("added.example.com");
    expect(box.read("home/.npmrc")).toContain(FAKE_NPM_TOKEN);
  });

  // The rewrite renames a temp file into place, which would leave a regular file
  // where the link was and detach the secret from the repo that owns it.
  test("refuses a credential reached through a symlink", () => {
    declareReference();
    stubOp(FAKE_NPM_TOKEN);
    const target = box.write("repo/npmrc", `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}\n`);
    symlinkSync(target, home(".npmrc"));

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is a symlink");
    expect(box.read("repo/npmrc")).toContain(FAKE_NPM_TOKEN);
  });

  test("refuses a file holding two different secrets", () => {
    declareReference();
    stubOp(FAKE_NPM_TOKEN);
    const second = "npm_222222222222222222222222222222222222";
    const contents = [
      `//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}`,
      `//registry.example.com/:_authToken=${second}`,
      "",
    ].join("\n");
    credential("home/.npmrc", contents);

    const result = runAudit(["--adopt"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds 2 different secrets");
    // One reference cannot stand in for both, and rewriting would have replaced
    // the second with a value nothing checked and nothing stored.
    expect(box.read("home/.npmrc")).toBe(contents);
    expect(result.stderr).not.toContain(second);
  });

  test("does nothing where op is not installed", () => {
    declareReference();
    // bun itself still has to resolve, since the shebang finds it on PATH.
    const result = run([audit, "--adopt"], {
      env: { HOME: home(), CREDENTIALS_ENV_DIR: box.path("env") },
      onlyPath: [box.bin, dirname(process.execPath)],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("op is not installed");
  });
});

test("rejects an argument it does not know", () => {
  const result = runAudit(["--fix"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unknown --fix");
});

test("rejects --enforce and --adopt together rather than running one of them", () => {
  const result = runAudit(["--enforce", "--adopt"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("separate runs");
});
