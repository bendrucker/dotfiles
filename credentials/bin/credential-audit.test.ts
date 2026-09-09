import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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
    env: { HOME: home(), ...env },
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

test("rejects an argument it does not know", () => {
  const result = runAudit(["--fix"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unknown --fix");
});
