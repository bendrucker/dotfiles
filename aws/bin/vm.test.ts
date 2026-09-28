import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";
import { formatMinutes, isoSeconds, parseDuration } from "../vm/duration.ts";
import { guestTools, toolLines } from "../vm/guest.ts";
import { HERDR } from "../vm/herdr.ts";
import { type Kind, type Kinds, loadKinds } from "../vm/kinds.ts";
import { installLines } from "../vm/release.ts";
import { sshEntry } from "../vm/ssh.ts";
import { extendedExpiry, parseLaunch, rows, shutdownCommand, userData } from "../vm/vm.ts";

const vmBin = join(repoRoot, "aws", "bin", "vm");

function makeKind(overrides: Partial<Kind> = {}): Kind {
  return { name: "performance", profile: "p", region: "us-east-1", template: "t", defaultTtl: 240, maxTtl: 720, tools: {}, ...overrides };
}

describe("kinds", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox("vm-kinds");
  });
  afterEach(() => box.remove());

  test("the shipped file defines performance as the default", () => {
    const kinds = loadKinds([join(repoRoot, "aws", "vm", "kinds.toml")]);
    expect(kinds.default).toBe("performance");
    expect(kinds.byName.get("performance")).toEqual({
      name: "performance",
      profile: "performance",
      region: "us-east-1",
      template: "performance",
      defaultTtl: 240,
      maxTtl: 720,
      tailnet: {
        tag: "tag:vm",
        role: "/managed/vm-launcher",
        clientIdParameter: "/vm/tailscale-client-id",
        audienceParameter: "/vm/tailscale-audience",
      },
      tools: {},
    });
  });

  test("a local file adds kinds, replaces one whole, and moves the default", () => {
    const shipped = join(repoRoot, "aws", "vm", "kinds.toml");
    box.write(
      "local.toml",
      `default = "ci"
[kinds.ci]
profile = "ci-admin"
region = "us-west-2"
template = "ci"
default_ttl = "1h"
max_ttl = "2h"
tools = { "aqua:x/y" = "1.0.0" }
[kinds.performance]
profile = "other"
region = "us-east-1"
template = "performance"
`,
    );
    const kinds = loadKinds([shipped, box.path("local.toml")]);
    expect(kinds.default).toBe("ci");
    expect(kinds.byName.get("ci")).toEqual({ name: "ci", profile: "ci-admin", region: "us-west-2", template: "ci", defaultTtl: 60, maxTtl: 120, tools: { "aqua:x/y": "1.0.0" } });
    expect(kinds.byName.get("performance")).toEqual(makeKind({ profile: "other", template: "performance" }));
  });

  test.each<{ name: string; toml: string; error: RegExp }>([
    { name: "no default", toml: `[kinds.a]\nprofile = "p"\nregion = "r"\ntemplate = "t"\n`, error: /no default kind/ },
    {
      name: "a tailnet without its role",
      toml: `default = "a"\n[kinds.a]\nprofile = "p"\nregion = "r"\ntemplate = "t"\n[kinds.a.tailnet]\nclient_id_parameter = "/c"\naudience_parameter = "/a"\n`,
      error: /role/,
    },
    {
      name: "a role that is not an IAM path",
      toml: `default = "a"\n[kinds.a]\nprofile = "p"\nregion = "r"\ntemplate = "t"\n[kinds.a.tailnet]\nrole = "vm-launcher"\nclient_id_parameter = "/c"\naudience_parameter = "/a"\n`,
      error: /IAM path and name/,
    },
    {
      name: "a default past the maximum",
      toml: `default = "a"\n[kinds.a]\nprofile = "p"\nregion = "r"\ntemplate = "t"\ndefault_ttl = "3h"\nmax_ttl = "2h"\n`,
      error: /exceeds max_ttl/,
    },
  ])("refuses $name", ({ toml, error }) => {
    box.write("kinds.toml", toml);
    expect(() => loadKinds([box.path("kinds.toml")])).toThrow(error);
  });
});

describe("durations", () => {
  test("reads minutes, hours, and both", () => {
    expect(parseDuration("30m")).toBe(30);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1h30m")).toBe(90);
  });

  test("refuses anything else", () => {
    for (const text of ["", "0m", "90", "1d", "h"]) expect(() => parseDuration(text)).toThrow();
  });

  test("formats back", () => {
    expect(formatMinutes(90)).toBe("1h30m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(-5)).toBe("0m");
  });
});

describe("launch options", () => {
  const kinds: Kinds = {
    default: "performance",
    byName: new Map([
      ["performance", makeKind()],
      ["ci", makeKind({ name: "ci", defaultTtl: 30, maxTtl: 60 })],
    ]),
  };

  test("defaults to the default kind's time limit and the template's type", () => {
    const options = parseLaunch([], kinds);
    expect(options.kind.name).toBe("performance");
    expect(options.ttlMinutes).toBe(240);
    expect(options.type).toBeUndefined();
    expect(options.name).toMatch(/^[a-z0-9]{4}$/);
  });

  test("takes the time limits of the kind it names", () => {
    expect(parseLaunch(["--kind", "ci"], kinds).ttlMinutes).toBe(30);
    expect(parseLaunch(["--ttl", "12h"], kinds).ttlMinutes).toBe(720);
    expect(() => parseLaunch(["--ttl", "12h1m"], kinds)).toThrow(/12h maximum for performance/);
    expect(() => parseLaunch(["--kind=ci", "--ttl", "2h"], kinds)).toThrow(/1h maximum for ci/);
  });

  test("passes the type through for the account to judge", () => {
    expect(parseLaunch(["--type=c7i.large"], kinds).type).toBe("c7i.large");
  });

  test("refuses an unknown kind and a name ssh or herdr would mangle", () => {
    expect(() => parseLaunch(["--kind", "nope"], kinds)).toThrow(/no kind named nope; defined: performance, ci/);
    expect(() => parseLaunch(["--name", "Has Space"], kinds)).toThrow(/name must be/);
  });
});

describe("user data", () => {
  const expires = new Date("2026-09-27T20:00:00Z");

  test("schedules the shutdown first, from the absolute expiry", () => {
    const lines = userData(expires, "ecdsa-sha2-nistp256 AAAA key\n").split("\n");
    expect(lines[1]).toBe(shutdownCommand(expires));
    expect(lines[1]).toContain(String(expires.getTime() / 1000));
  });

  test("installs the keys for ec2-user", () => {
    const script = userData(expires, "ecdsa-sha2-nistp256 AAAA one\nssh-ed25519 BBBB two\n");
    expect(script).toContain("ecdsa-sha2-nistp256 AAAA one\nssh-ed25519 BBBB two\nKEYS");
    expect(script).toContain("/home/ec2-user/.ssh/authorized_keys");
    expect(script).not.toContain("tailscale");
  });

  test("installs git, perf, and rsync and gives ec2-user a git identity", () => {
    const script = userData(expires, "k");
    expect(script).toContain("dnf install -y -q git perf rsync");
    expect(script).toContain("runuser -u ec2-user -- git config --global user.email ec2-user@localhost");
  });

  test("joins the tailnet under the VM's alias and tag", () => {
    const script = userData(expires, "k", { tailnet: { authKey: "tskey-auth-fake", hostname: "vm-abcd", tag: "tag:vm" } });
    expect(script).toContain("tailscale up --auth-key=tskey-auth-fake --hostname=vm-abcd --advertise-tags=tag:vm");
  });

  test("installs the herdr build for the VM's architecture only if its digest matches", () => {
    const lines = installLines(HERDR, [
      { arch: "aarch64", url: "https://example.test/arm", sha256: "a".repeat(64) },
      { arch: "x86_64", url: "https://example.test/x86", sha256: "b".repeat(64) },
    ]);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "case "$(uname -m)" in
        aarch64) herdr_url=https://example.test/arm herdr_sum=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
        x86_64) herdr_url=https://example.test/x86 herdr_sum=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
      esac
      install -d -o ec2-user -g ec2-user /home/ec2-user/.local /home/ec2-user/.local/bin
      curl -fsSL --retry 3 -o /tmp/herdr "$herdr_url"
      echo "$herdr_sum  /tmp/herdr" | sha256sum -c - &&
        install -m 755 -o ec2-user -g ec2-user /tmp/herdr /home/ec2-user/.local/bin/herdr"
    `);
  });

  test.each<[string, string]>([
    ["aarch64", "arm"],
    ["x86_64", "x86"],
  ])("the herdr install on %s downloads %s", (arch, url) => {
    const box = sandbox("vm-uname");
    box.stub("uname", `echo ${arch}`);
    const lines = installLines(HERDR, [
      { arch: "aarch64", url: "arm", sha256: "a" },
      { arch: "x86_64", url: "x86", sha256: "b" },
    ]);
    const picked = run(["sh", "-c", `${lines.slice(0, 4).join("\n")}\necho "$herdr_url"`], { path: [box.bin] });
    box.remove();
    expect(picked.stdout.trim()).toBe(url);
  });

  test("a digest mismatch installs nothing", () => {
    const box = sandbox("vm-digest");
    box.stub("uname", "echo aarch64");
    box.stub("curl", "exit 0");
    box.stub("sha256sum", "exit 1");
    box.stub("install", `echo "install $*"`);
    const lines = installLines(HERDR, [{ arch: "aarch64", url: "arm", sha256: "a" }]);
    const ran = run(["sh", "-c", lines.join("\n")], { path: [box.bin] });
    box.remove();
    expect(ran.stdout).toContain("install -d");
    expect(ran.stdout).not.toContain("install -m");
  });

  test("installs mise, writes the tools as its global config, and records how the install went", () => {
    const lines = toolLines([{ arch: "aarch64", url: "https://example.test/mise", sha256: "c".repeat(64) }], {
      "aqua:BurntSushi/ripgrep": "15.2.0",
      "github:a/b": "1.0.0",
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "case "$(uname -m)" in
        aarch64) mise_url=https://example.test/mise mise_sum=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc ;;
      esac
      install -d -o ec2-user -g ec2-user /home/ec2-user/.local /home/ec2-user/.local/bin
      curl -fsSL --retry 3 -o /tmp/mise "$mise_url"
      echo "$mise_sum  /tmp/mise" | sha256sum -c - &&
        install -m 755 -o ec2-user -g ec2-user /tmp/mise /home/ec2-user/.local/bin/mise
      install -d -o ec2-user -g ec2-user /home/ec2-user/.config /home/ec2-user/.config/mise
      cat > /home/ec2-user/.config/mise/config.toml <<'TOOLS'
      [tools]
      "aqua:BurntSushi/ripgrep" = "15.2.0"
      "github:a/b" = "1.0.0"
      TOOLS
      echo 'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"' >> /home/ec2-user/.bashrc
      chown ec2-user:ec2-user /home/ec2-user/.config/mise/config.toml /home/ec2-user/.bashrc
      install -d /var/lib/vm
      runuser -l ec2-user -c 'MISE_YES=1 /home/ec2-user/.local/bin/mise install' > /var/log/vm-tools.log 2>&1; echo $? > /var/lib/vm/tools-status"
    `);
  });

  test("a kind's tools add to the shipped set and override its pins", () => {
    const tools = guestTools(makeKind({ tools: { "aqua:BurntSushi/ripgrep": "1.0.0", "aqua:x/y": "2.0.0" } }));
    expect(tools["aqua:BurntSushi/ripgrep"]).toBe("1.0.0");
    expect(tools["aqua:x/y"]).toBe("2.0.0");
    expect(tools["aqua:sharkdp/fd"]).toBeDefined();
  });

  test("the scheduled minutes round up and land on the expiry", () => {
    const now = Math.floor(Date.now() / 1000);
    const command = shutdownCommand(new Date((now + 3601) * 1000)).replace("shutdown -h ", "echo ");
    expect(run(["sh", "-c", command]).stdout.trim()).toMatch(/^\+6[01]$/);
  });
});

describe("ssh entry", () => {
  const tools = { aws: "/a", plugin: "/p/s", profile: "x", region: "us-east-1" };

  test("proxies through Session Manager by absolute path", () => {
    const entry = sshEntry("vm-abcd", "i-0123", undefined, "/home/u/.local/state/vm/abcd.known_hosts", {
      aws: "/opt/homebrew/bin/aws",
      plugin: "/opt/homebrew/bin/session-manager-plugin",
      profile: "performance-admin",
      region: "us-west-2",
    });
    expect(entry).toContain("Host vm-abcd\n  HostName i-0123\n  ProxyCommand ");
    expect(entry).toContain("Host vm-abcd-ssm\n  HostName i-0123\n  ProxyCommand ");
    expect(entry).toContain(
      "ProxyCommand /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/aws ssm start-session --profile performance-admin --region us-west-2 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p",
    );
    expect(entry).toContain("UserKnownHostsFile /home/u/.local/state/vm/abcd.known_hosts");
  });

  test("carries a non-default AWS config file along", () => {
    const entry = sshEntry("h", "i-1", undefined, "/k", { ...tools, configFile: "/c/aws config" });
    expect(entry).toContain("'AWS_CONFIG_FILE=/c/aws config'");
  });

  test("goes direct over the tailnet and keeps Session Manager under -ssm", () => {
    const entry = sshEntry("h", "i-1", "100.64.0.9", "/k", tools);
    const [direct, ssm] = entry.split("\n\n");
    expect(direct).toStartWith("Host h\n  HostName 100.64.0.9\n  User ec2-user");
    expect(direct).not.toContain("ProxyCommand");
    expect(ssm).toStartWith("Host h-ssm\n  HostName i-1\n  ProxyCommand ");
    expect(direct).toContain("HostKeyAlias h\n");
    expect(ssm).toContain("HostKeyAlias h\n");
  });
});

describe("extending", () => {
  const launchedAt = new Date("2026-09-27T08:00:00Z");
  const now = new Date("2026-09-27T10:00:00Z");

  test("adds to the current expiry", () => {
    const next = extendedExpiry({ launchedAt, expiresAt: new Date("2026-09-27T12:00:00Z") }, 120, 720, now);
    expect(isoSeconds(next)).toBe("2026-09-27T14:00:00Z");
  });

  test("reaches exactly 12h after launch and refuses past it", () => {
    const vm = { launchedAt, expiresAt: new Date("2026-09-27T18:00:00Z") };
    expect(isoSeconds(extendedExpiry(vm, 120, 720, now))).toBe("2026-09-27T20:00:00Z");
    expect(() => extendedExpiry(vm, 121, 720, now)).toThrow(/passes the 12h limit .* at most 2h remains/);
  });
});

describe("rows", () => {
  const now = new Date("2026-09-27T10:00:00Z");
  const machines = [{ id: "m1", label: "vm-live", target: "vm-live" }];

  test("shows remaining time and the herdr label", () => {
    const vm = {
      id: "i-1",
      name: "live",
      kind: "performance",
      type: "c8g.medium",
      state: "running",
      launchedAt: now,
      expiresAt: new Date("2026-09-27T11:30:00Z"),
    };
    expect(rows([vm], [{ name: "live", kind: "performance" }], machines, now)).toEqual([
      {
        name: "live",
        kind: "performance",
        herdr: "vm-live",
        instance: "i-1",
        type: "c8g.medium",
        state: "running",
        expiresAt: "2026-09-27T11:30:00Z",
        remaining: "1h30m",
      },
    ]);
  });

  test("shows a stopped VM as paused, without the expiry that stopped it", () => {
    const vm = { id: "i-1", name: "p", kind: "performance", type: "c8g.medium", state: "stopped", launchedAt: now, expiresAt: now };
    expect(rows([vm], [{ name: "p", kind: "performance" }], [], now)[0]).toMatchObject({ state: "paused", expiresAt: "", remaining: "" });
  });

  test("keeps a name whose instance is gone until destroy cleans it up", () => {
    expect(rows([], [{ name: "old", kind: "ci" }], [], now)).toEqual([
      { name: "old", kind: "ci", herdr: "", instance: "", type: "", state: "gone", expiresAt: "", remaining: "" },
    ]);
  });
});

// Each stub appends its argv to calls.log. The aws stub keeps one instance in
// instance.json from run-instances until terminate-instances.
function stubs(box: Sandbox): void {
  const log = box.path("calls.log");
  const state = box.path("instance.json");
  const parameters = box.path("tailnet-parameters");
  box.stub(
    "aws",
    `echo "aws $*" >> ${log}
case "$1 $2" in
  "ec2 describe-instances")
    case "$*" in
      *other-profile*) echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2; exit 255 ;;
      *missing-profile*) echo "aws: [ERROR]: The config profile (missing-profile) could not be found" >&2; exit 255 ;;
    esac
    if [ -f ${state} ]; then printf '{"Reservations":[{"Instances":[%s]}]}' "$(cat ${state})"; else echo '{"Reservations":[]}'; fi ;;
  "ec2 run-instances")
    echo '{"InstanceId":"i-0abc","InstanceType":"c8g.medium","State":{"Name":"pending"},"LaunchTime":"2026-09-27T08:00:00Z","Tags":[{"Key":"vm-name","Value":"t1"},{"Key":"vm-kind","Value":"performance"},{"Key":"expires-at","Value":"2026-09-27T08:30:00Z"}]}' > ${state}
    printf '{"Instances":[%s]}' "$(cat ${state})" ;;
  "ec2 terminate-instances") rm -f ${state}; echo '{}' ;;
  "ec2 stop-instances") sed -i.bak 's/"pending"/"stopped"/' ${state}; echo '{}' ;;
  "ec2 start-instances") sed -i.bak 's/"stopped"/"running"/' ${state}; echo '{}' ;;
  "ec2 create-tags") ;;
  "ssm describe-instance-information") echo '{"InstanceInformationList":[{"PingStatus":"Online"}]}' ;;
  "ssm send-command") echo "$*" > ${box.path("sent")}; echo '{"Command":{"CommandId":"c-1"}}' ;;
  "ssm get-command-invocation")
    if [ -f ${box.path("unready")} ]; then echo '{"Status":"Failed","StandardErrorContent":"no keys"}'
    elif grep -q tools-status ${box.path("sent")}; then printf '{"Status":"Success","StandardOutputContent":"%s"}' "$(cat ${box.path("tools-status")} 2>/dev/null || echo 0)"
    else echo '{"Status":"Success","StandardOutputContent":"100.64.0.9"}'; fi ;;
  "ssm get-parameters")
    if [ -f ${parameters} ]; then echo '{"Parameters":[{"Name":"/vm/tailscale-client-id","Value":"client-fake"},{"Name":"/vm/tailscale-audience","Value":"audience-fake"}],"InvalidParameters":[]}'
    else echo '{"Parameters":[],"InvalidParameters":["/vm/tailscale-client-id","/vm/tailscale-audience"]}'; fi ;;
  "sts get-caller-identity") echo '{"Account":"000000000000"}' ;;
  "sts assume-role") echo '{"Credentials":{"AccessKeyId":"ASIAROLE","SecretAccessKey":"s","SessionToken":"t"}}' ;;
  "sts get-web-identity-token")
    echo "  as AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID AWS_PROFILE=\${AWS_PROFILE:-unset}" >> ${log}
    if [ -f ${box.path("foreign-jwt")} ]; then echo '{"WebIdentityToken":"jwt-foreign"}'; else echo '{"WebIdentityToken":"jwt-fake"}'; fi ;;
esac`,
  );
  box.stub("session-manager-plugin", "exit 0");
  box.stub("mise", `echo "2026.9.15 linux-arm64"`);
  box.stub("ssh-add", `echo "ssh-add $*" >> ${log}; echo "ecdsa-sha2-nistp256 AAAAfake test@example"`);
  box.stub("ssh", `echo "ssh $*" >> ${log}; [ "$1" = -G ] && echo "hostname i-0abc"; exit 0`);
  box.stub("rsync", `echo "rsync $*" >> ${log}`);
  box.stub(
    "herdr",
    `echo "herdr $*" >> ${log}
case "$1 $2" in
  "--version ") echo "herdr 0.9.1" ;;
  "machine list")
    if [ -f ${box.path("herdr-down")} ]; then echo "server not running" >&2; exit 1; fi
    echo '[{"id":"m9","label":"vm-t1","target":"vm-t1"}]' ;;
esac`,
  );
}

const DIGEST = "f".repeat(64);

// Stands in for the Tailscale and GitHub APIs a launch calls, recording each
// Tailscale request body.
let api: ReturnType<typeof Bun.serve>;
const tailscaleRequests: { path: string; body: string; authorization: string | null }[] = [];

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/repos/herdrdev/herdr/releases/tags/v0.9.1") {
        return Response.json({
          assets: [
            { name: "herdr-linux-aarch64", browser_download_url: "https://example.test/herdr-linux-aarch64", digest: `sha256:${DIGEST}` },
            { name: "herdr-linux-x86_64", browser_download_url: "https://example.test/herdr-linux-x86_64", digest: null },
          ],
        });
      }
      if (path === "/repos/jdx/mise/releases/tags/v2026.9.15") {
        return Response.json({
          assets: [{ name: "mise-v2026.9.15-linux-arm64", browser_download_url: "https://example.test/mise-linux-arm64", digest: `sha256:${DIGEST}` }],
        });
      }
      const body = await request.text();
      const authorization = request.headers.get("authorization");
      tailscaleRequests.push({ path, body, authorization });
      if (path === "/api/v2/oauth/token-exchange") {
        const form = new URLSearchParams(body);
        if (form.get("client_id") !== "client-fake" || form.get("jwt") !== "jwt-fake") return new Response("bad token", { status: 401 });
        return Response.json({ access_token: "exchanged" });
      }
      if (path !== "/api/v2/tailnet/-/keys" || authorization !== "Bearer exchanged") return new Response("unauthorized", { status: 401 });
      return Response.json({ key: "tskey-auth-minted" });
    },
  });
});

afterAll(() => api.stop());

// A launch spawns a couple dozen stubs, and a busy machine takes two of them
// past the 5s default.
setDefaultTimeout(30_000);

// Replaces the shipped performance kind, so every command reaches the stub
// account alone.
const KINDS = `[kinds.performance]
profile = "test-profile"
region = "us-east-1"
template = "performance"

[kinds.performance.tailnet]
role = "/managed/vm-launcher"
client_id_parameter = "/vm/tailscale-client-id"
audience_parameter = "/vm/tailscale-audience"
`;

describe("commands", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("vm");
    box.mkdir("home");
    box.write("config/vm/kinds.toml", KINDS);
    stubs(box);
  });

  afterEach(() => box.remove());

  const env = () => ({
    ...process.env,
    PATH: `${box.bin}:${process.env.PATH}`,
    HOME: box.path("home"),
    XDG_CONFIG_HOME: box.path("config"),
    XDG_STATE_HOME: box.path("state"),
    AWS_PROFILE: "inherited",
    VM_TAILSCALE_API: api.url.origin,
    VM_GITHUB_API: api.url.origin,
    VM_POLL_MS: "50",
  });
  // A synchronous spawn would block the fake APIs, which answer in this process.
  const perf = async (...args: string[]): Promise<Run> => {
    const child = Bun.spawn([vmBin, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { status, stdout, stderr };
  };
  const calls = () => box.read("calls.log");
  const entry = () => box.path("state", "vm", "t1.conf");

  test("launch tags, wires ssh, waits, and registers with herdr", async () => {
    const launched = await perf("launch", "--name", "t1", "--type", "c8g.medium", "--ttl", "30m");
    expect(launched.stderr).not.toContain("does not include");
    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain("kind: performance\ninstance: i-0abc\n");
    expect(launched.stdout).toContain("herdr-machine: vm-t1\n");

    const log = calls();
    expect(log).toContain("--launch-template LaunchTemplateName=performance --instance-type c8g.medium");
    expect(log).toContain('{"Key":"vm-kind","Value":"performance"},{"Key":"expires-at","Value":"20');
    expect(log).toContain("shutdown -h +$((");
    expect(log).toContain("ecdsa-sha2-nistp256 AAAAfake test@example");
    expect(log).toContain("--profile test-profile --region us-east-1");
    expect(log).toContain("herdr machine add --label vm-t1 vm-t1");
    expect(log).toContain("herdr --machine vm-t1 workspace list");
    expect(box.read("state/vm/t1.conf")).toContain("HostName i-0abc");
    expect(launched.stderr).toContain("no /vm/tailscale-client-id or /vm/tailscale-audience parameter, so this VM is reachable through Session Manager only");
    expect(launched.stdout).toContain("tailnet: none");
    expect(log).not.toContain("tailscale up");
    expect(log).toContain(`aarch64) herdr_url=https://example.test/herdr-linux-aarch64 herdr_sum=${DIGEST} ;;`);
    expect(log).not.toContain("herdr-linux-x86_64");
    expect(box.read("state/vm/t1.json")).toBe('{"kind":"performance"}\n');
    expect(log).toContain(`aarch64) mise_url=https://example.test/mise-linux-arm64 mise_sum=${DIGEST} ;;`);
    expect(log).toContain('"aqua:BurntSushi/ripgrep" = "15.2.0"');
    expect(log).toContain("cat /var/lib/vm/tools-status");
    expect(launched.stderr).not.toContain("could not install");
  });

  test("launch reports tools mise could not install and keeps the VM", async () => {
    box.write("tools-status", "1");
    const launched = await perf("launch", "--name", "t1");
    expect(launched.status).toBe(0);
    expect(launched.stderr).toContain("mise could not install every tool (exit 1); see /var/log/vm-tools.log on the VM");
    expect(calls()).not.toContain("terminate-instances");
  });

  test("launch writes the real plugin behind a mise shim into the ssh entry", async () => {
    run(["rm", box.path("bin", "session-manager-plugin")]);
    box.stub("mise/shims/session-manager-plugin", "exit 1");
    box.stub("mise", `echo "mise $*" >> ${box.path("calls.log")}; echo /opt/mise/installs/smp/bin/session-manager-plugin`);
    const child = Bun.spawn([vmBin, "launch", "--name", "t1"], {
      env: { ...env(), PATH: `${box.bin}:${box.path("mise", "shims")}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(calls()).toContain(`mise -C ${join(repoRoot, "aws")} which session-manager-plugin`);
    expect(box.read("state/vm/t1.conf")).toContain("ProxyCommand /usr/bin/env PATH=/opt/mise/installs/smp/bin:/usr/bin:/bin ");
  });

  test("launch joins the tailnet through the role's exchanged identity token", async () => {
    box.write("tailnet-parameters", "");
    tailscaleRequests.length = 0;
    const launched = await perf("launch", "--name", "t1");
    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain("tailnet: 100.64.0.9\n");
    const log = calls();
    expect(log).toContain("aws ssm get-parameters --names /vm/tailscale-client-id /vm/tailscale-audience --profile test-profile");
    expect(log).toContain(
      "aws sts assume-role --role-arn arn:aws:iam::000000000000:role/managed/vm-launcher --role-session-name vm-t1 --profile test-profile",
    );
    expect(log).toContain(
      "aws sts get-web-identity-token --audience audience-fake --signing-algorithm RS256 --region us-east-1 --output json\n  as AWS_ACCESS_KEY_ID=ASIAROLE AWS_PROFILE=unset",
    );
    expect(log).toContain("tailscale up --auth-key=tskey-auth-minted --hostname=vm-t1 --advertise-tags=tag:vm");
    expect(tailscaleRequests.map((request) => request.path)).toEqual(["/api/v2/oauth/token-exchange", "/api/v2/tailnet/-/keys"]);
    expect(JSON.parse(tailscaleRequests[1].body).capabilities.devices.create).toEqual({
      reusable: false,
      ephemeral: true,
      preauthorized: true,
      tags: ["tag:vm"],
    });
    const [direct, ssm] = box.read("state/vm/t1.conf").split("\n\n");
    expect(direct).toContain("HostName 100.64.0.9");
    expect(ssm).toContain("HostName i-0abc");
  });

  test("launch falls back to Session Manager when Tailscale refuses the token", async () => {
    box.write("tailnet-parameters", "");
    box.write("foreign-jwt", "");
    const launched = await perf("launch", "--name", "t1");
    expect(launched.status).toBe(0);
    expect(launched.stderr).toContain("Tailscale token exchange failed: 401 bad token; falling back to Session Manager only");
    expect(launched.stdout).toContain("tailnet: none");
    expect(calls()).not.toContain("tailscale up");
  });

  test("launch destroys a VM that never became ready", async () => {
    box.write("unready", "");
    const launched = await perf("launch", "--name", "t1");
    expect(launched.status).toBe(1);
    expect(launched.stderr).toContain("no keys");
    expect(calls()).toContain("aws ec2 terminate-instances --instance-ids i-0abc");
    expect(existsSync(entry())).toBe(false);
  });

  test("launch stops before run-instances when it cannot write its local files", async () => {
    box.mkdir("state/vm");
    chmodSync(box.path("state", "vm"), 0o500);
    const launched = await perf("launch", "--name", "t1");
    chmodSync(box.path("state", "vm"), 0o700);
    expect(launched.status).toBe(1);
    expect(launched.stderr).toContain("EACCES");
    expect(calls()).not.toContain("run-instances");
  });

  test("launch refuses a name already running", async () => {
    await perf("launch", "--name", "t1");
    const again = await perf("launch", "--name", "t1");
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("already exists");
  });

  test("list shows type, remaining time, and the herdr label", async () => {
    await perf("launch", "--name", "t1");
    const listed = await perf("list", "--json");
    expect(listed.status).toBe(0);
    const [row] = JSON.parse(listed.stdout);
    expect(row).toMatchObject({ name: "t1", kind: "performance", herdr: "vm-t1", type: "c8g.medium", state: "pending" });
  });

  test("pause stops the VM and keeps its ssh entry", async () => {
    await perf("launch", "--name", "t1");
    const paused = await perf("pause", "t1");
    expect(paused.status).toBe(0);
    expect(calls()).toContain("aws ec2 stop-instances --instance-ids i-0abc");
    expect(existsSync(entry())).toBe(true);
    const [row] = JSON.parse((await perf("list", "--json")).stdout);
    expect(row).toMatchObject({ state: "paused", remaining: "" });
  });

  test("extend refuses a paused VM", async () => {
    await perf("launch", "--name", "t1");
    await perf("pause", "t1");
    const extended = await perf("extend", "t1", "1h");
    expect(extended.status).toBe(2);
    expect(extended.stderr).toContain("t1 is paused, not pending or running");
  });

  test("resume retags before starting, reschedules shutdown, and waits for herdr", async () => {
    await perf("launch", "--name", "t1");
    await perf("pause", "t1");
    box.write("calls.log", "");
    const resumed = await perf("resume", "t1", "--ttl", "1h");
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("herdr-machine: vm-t1\n");
    const log = calls();
    expect(log.indexOf("ec2 create-tags --resources i-0abc --tags Key=expires-at")).toBeLessThan(log.indexOf("ec2 start-instances"));
    expect(log).toContain("shutdown -h +$((");
    expect(log).toContain("herdr --machine vm-t1 workspace list");
    expect(log.indexOf("herdr machine remove m9")).toBeLessThan(log.indexOf("herdr machine add --label vm-t1"));
    expect(log).not.toMatch(/protection|DisableApiStop|DisableApiTermination/);
  });

  test("resume waits for a stop still in progress", async () => {
    await perf("launch", "--name", "t1");
    box.write("instance.json", box.read("instance.json").replace('"pending"', '"stopping"'));
    const resumed = perf("resume", "t1");
    await Bun.sleep(500);
    box.write("instance.json", box.read("instance.json").replace('"stopping"', '"stopped"'));
    expect((await resumed).status).toBe(0);
  });

  test("resume refuses a running VM and more than 12h", async () => {
    await perf("launch", "--name", "t1");
    expect((await perf("resume", "t1")).stderr).toContain("t1 is pending, not stopping or paused");
    await perf("pause", "t1");
    expect((await perf("resume", "t1", "--ttl", "13h")).stderr).toContain("exceeds the 12h maximum for performance");
  });

  test("extend refuses past 12h after launch", async () => {
    await perf("launch", "--name", "t1");
    const extended = await perf("extend", "t1", "12h");
    expect(extended.status).toBe(2);
    expect(extended.stderr).toContain("passes the 12h limit");
    expect(calls()).not.toContain("create-tags");
  });

  test.each([
    { name: "an expired sign-in", profile: "other-profile", hint: "Sign in with: aws sso login --profile other-profile" },
    {
      name: "a missing profile",
      profile: "missing-profile",
      hint: "Add a [profile missing-profile] stanza to ~/.aws/config with sso_session, sso_account_id, sso_role_name, and region, then sign in with: aws sso login --profile missing-profile",
    },
  ])("list shows every other account, names the fix for $name, and exits nonzero", async ({ profile, hint }) => {
    box.write("config/vm/kinds.toml", `${KINDS}[kinds.other]\nprofile = "${profile}"\nregion = "eu-west-1"\ntemplate = "other"\n`);
    await perf("launch", "--name", "t1");
    const listed = await perf("list", "--json");
    expect(listed.status).toBe(1);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    expect(listed.stderr).toContain(`skipping ${profile} in eu-west-1: aws ec2 describe-instances failed`);
    expect(listed.stderr).toContain(hint);
  });

  test.each([
    { name: "launch", args: ["launch", "--help"] },
    { name: "a flag after others", args: ["launch", "--name", "t1", "-h"] },
    { name: "destroy", args: ["destroy", "--help"] },
    { name: "connect", args: ["connect", "--help"] },
  ])("--help on $name prints usage with the kinds files and does nothing else", async ({ args }) => {
    const helped = await perf(...args);
    expect(helped.status).toBe(0);
    expect(helped.stdout).toContain("Usage: vm <command>");
    expect(helped.stdout).toContain(`Kinds come from ${join(repoRoot, "aws", "vm", "kinds.toml")}\nand ${box.path("config", "vm", "kinds.toml")}.`);
    expect(existsSync(box.path("calls.log"))).toBe(false);
  });

  test("connect passes a help flag after the name to the remote command", async () => {
    await perf("launch", "--name", "t1");
    expect((await perf("connect", "t1", "ls", "--help")).status).toBe(0);
    expect(calls()).toContain("ssh vm-t1 ls --help");
  });

  test("copy rsyncs into the home directory or a destination, leaving out node_modules", async () => {
    await perf("launch", "--name", "t1");
    expect((await perf("copy", "t1", "./")).status).toBe(0);
    expect((await perf("copy", "t1", "src/", "work")).status).toBe(0);
    expect(calls()).toContain("rsync -az --exclude node_modules ./ vm-t1:\n");
    expect(calls()).toContain("rsync -az --exclude node_modules src/ vm-t1:work\n");
  });

  test("copy refuses a VM this machine has no entry for", async () => {
    const copied = await perf("copy", "t1", "./");
    expect(copied.status).toBe(1);
    expect(copied.stderr).toContain("no SSH entry for t1");
  });

  test("destroy terminates and removes the ssh entry and herdr machine", async () => {
    await perf("launch", "--name", "t1");
    const destroyed = await perf("destroy", "t1");
    expect(destroyed.status).toBe(0);
    expect(calls()).toContain("aws ec2 terminate-instances --instance-ids i-0abc");
    expect(calls()).toContain("herdr machine remove m9");
    expect(existsSync(entry())).toBe(false);
    expect(existsSync(box.path("state", "vm", "t1.json"))).toBe(false);
  });

  test("destroy finishes when herdr cannot list its machines", async () => {
    await perf("launch", "--name", "t1");
    box.write("herdr-down", "");
    const destroyed = await perf("destroy", "t1");
    expect(destroyed.status).toBe(0);
    expect(destroyed.stderr).toContain("server not running");
    expect(existsSync(entry())).toBe(false);
  });

  test("destroy cleans up after a VM that already terminated", async () => {
    await perf("launch", "--name", "t1");
    box.write("instance.json", "");
    run(["rm", box.path("instance.json")]);
    const destroyed = await perf("destroy", "t1");
    expect(destroyed.status).toBe(0);
    expect(calls()).not.toContain("terminate-instances");
    expect(existsSync(entry())).toBe(false);
  });

  test("destroy names the files it could not remove, and a rerun finishes", async () => {
    await perf("launch", "--name", "t1");
    chmodSync(box.path("state", "vm"), 0o500);
    const blocked = await perf("destroy", "t1");
    chmodSync(box.path("state", "vm"), 0o700);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain(`could not remove ${box.path("state", "vm", "t1.json")}, ${box.path("state", "vm", "t1.conf")} (EACCES)`);
    expect(blocked.stderr).toContain("Finish with: vm destroy t1");
    expect(calls()).toContain("herdr machine remove m9");
    expect(existsSync(entry())).toBe(true);

    const finished = await perf("destroy", "t1");
    expect(finished.status).toBe(0);
    expect(calls().match(/terminate-instances/g)).toHaveLength(1);
    expect(existsSync(entry())).toBe(false);
  });
});
