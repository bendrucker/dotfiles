import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Run, type Sandbox } from "#harness";
import {
  extendedExpiry,
  formatMinutes,
  isoSeconds,
  parseDuration,
  parseLaunch,
  rows,
  shutdownCommand,
  userData,
} from "../perf-vm/perf-vm.ts";
import { sshEntry } from "../perf-vm/ssh.ts";

const perfVm = join(repoRoot, "aws", "bin", "perf-vm");

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
  test("defaults to four hours and the template's type", () => {
    const options = parseLaunch([]);
    expect(options.ttlMinutes).toBe(240);
    expect(options.type).toBeUndefined();
    expect(options.name).toMatch(/^[a-z0-9]{4}$/);
  });

  test("accepts 12h and refuses more", () => {
    expect(parseLaunch(["--ttl", "12h"]).ttlMinutes).toBe(720);
    expect(() => parseLaunch(["--ttl", "12h1m"])).toThrow(/12h maximum/);
  });

  test("refuses a type the account's policy denies", () => {
    expect(parseLaunch(["--type=c8g.medium"]).type).toBe("c8g.medium");
    expect(parseLaunch(["--type", "r8g.metal-24xl"]).type).toBe("r8g.metal-24xl");
    expect(() => parseLaunch(["--type", "c8g.24xlarge"])).toThrow(/not allowed/);
    expect(() => parseLaunch(["--type", "c7g.large"])).toThrow(/not allowed/);
  });

  test("refuses a name ssh or herdr would mangle", () => {
    expect(() => parseLaunch(["--name", "Has Space"])).toThrow(/name must be/);
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

  test("joins the tailnet under the VM's alias and tag", () => {
    const script = userData(expires, "k", { tailnet: { authKey: "tskey-auth-fake", hostname: "perf-vm-abcd" } });
    expect(script).toContain("tailscale up --auth-key=tskey-auth-fake --hostname=perf-vm-abcd --advertise-tags=tag:perf-vm");
  });

  test("installs the local herdr release only if its digest matches", () => {
    const script = userData(expires, "k", { herdr: { url: "https://example.test/herdr", sha256: "abc123" } });
    expect(script).toContain("curl -fsSL --retry 3 -o /tmp/herdr https://example.test/herdr\necho 'abc123  /tmp/herdr' | sha256sum -c -\n");
    expect(script).toContain("install -m 755 -o ec2-user -g ec2-user /tmp/herdr /home/ec2-user/.local/bin/herdr");
  });

  test("the scheduled minutes round up and land on the expiry", () => {
    const now = Math.floor(Date.now() / 1000);
    const command = shutdownCommand(new Date((now + 3601) * 1000)).replace("shutdown -h ", "echo ");
    expect(run(["sh", "-c", command]).stdout.trim()).toMatch(/^\+6[01]$/);
  });
});

describe("ssh entry", () => {
  const tools = { aws: "/a", plugin: "/p/s", profile: "x" };

  test("proxies through Session Manager by absolute path", () => {
    const entry = sshEntry("perf-vm-abcd", "i-0123", undefined, "/home/u/.ssh/perf-vm/abcd.known_hosts", {
      aws: "/opt/homebrew/bin/aws",
      plugin: "/opt/homebrew/bin/session-manager-plugin",
      profile: "performance-admin",
    });
    expect(entry).toContain("Host perf-vm-abcd\n  HostName i-0123\n  ProxyCommand ");
    expect(entry).toContain("Host perf-vm-abcd-ssm\n  HostName i-0123\n  ProxyCommand ");
    expect(entry).toContain(
      "ProxyCommand /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/aws ssm start-session --profile performance-admin --region us-east-1 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p",
    );
    expect(entry).toContain("UserKnownHostsFile /home/u/.ssh/perf-vm/abcd.known_hosts");
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
    const next = extendedExpiry({ launchedAt, expiresAt: new Date("2026-09-27T12:00:00Z") }, 120, now);
    expect(isoSeconds(next)).toBe("2026-09-27T14:00:00Z");
  });

  test("reaches exactly 12h after launch and refuses past it", () => {
    const vm = { launchedAt, expiresAt: new Date("2026-09-27T18:00:00Z") };
    expect(isoSeconds(extendedExpiry(vm, 120, now))).toBe("2026-09-27T20:00:00Z");
    expect(() => extendedExpiry(vm, 121, now)).toThrow(/at most 2h remains/);
  });
});

describe("rows", () => {
  const now = new Date("2026-09-27T10:00:00Z");
  const machines = [{ id: "m1", label: "perf-vm-live", target: "perf-vm-live" }];

  test("shows remaining time and the herdr label", () => {
    const vm = {
      id: "i-1",
      name: "live",
      type: "c8g.medium",
      state: "running",
      launchedAt: now,
      expiresAt: new Date("2026-09-27T11:30:00Z"),
    };
    expect(rows([vm], ["live"], machines, now)).toEqual([
      {
        name: "live",
        herdr: "perf-vm-live",
        instance: "i-1",
        type: "c8g.medium",
        state: "running",
        expiresAt: "2026-09-27T11:30:00Z",
        remaining: "1h30m",
      },
    ]);
  });

  test("shows a stopped VM as paused, without the expiry that stopped it", () => {
    const vm = { id: "i-1", name: "p", type: "c8g.medium", state: "stopped", launchedAt: now, expiresAt: now };
    expect(rows([vm], ["p"], [], now)[0]).toMatchObject({ state: "paused", expiresAt: "", remaining: "" });
  });

  test("keeps a name whose instance is gone until destroy cleans it up", () => {
    expect(rows([], ["old"], [], now)).toEqual([
      { name: "old", herdr: "", instance: "", type: "", state: "gone", expiresAt: "", remaining: "" },
    ]);
  });
});

// Each stub appends its argv to calls.log. The aws stub keeps one instance in
// instance.json from run-instances until terminate-instances.
function stubs(box: Sandbox): void {
  const log = box.path("calls.log");
  const state = box.path("instance.json");
  const secret = box.path("tailscale-secret");
  box.stub(
    "aws",
    `echo "aws $*" >> ${log}
case "$1 $2" in
  "ec2 describe-instances")
    if [ -f ${state} ]; then printf '{"Reservations":[{"Instances":[%s]}]}' "$(cat ${state})"; else echo '{"Reservations":[]}'; fi ;;
  "ec2 run-instances")
    echo '{"InstanceId":"i-0abc","InstanceType":"c8g.medium","State":{"Name":"pending"},"LaunchTime":"2026-09-27T08:00:00Z","Tags":[{"Key":"perf-vm","Value":"t1"},{"Key":"expires-at","Value":"2026-09-27T08:30:00Z"}]}' > ${state}
    printf '{"Instances":[%s]}' "$(cat ${state})" ;;
  "ec2 terminate-instances") rm -f ${state}; echo '{}' ;;
  "ec2 stop-instances") sed -i.bak 's/"pending"/"stopped"/' ${state}; echo '{}' ;;
  "ec2 start-instances") sed -i.bak 's/"stopped"/"running"/' ${state}; echo '{}' ;;
  "ec2 create-tags") ;;
  "ssm describe-instance-information") echo '{"InstanceInformationList":[{"PingStatus":"Online"}]}' ;;
  "ssm send-command") echo '{"Command":{"CommandId":"c-1"}}' ;;
  "ssm get-command-invocation") echo '{"Status":"Success","StandardOutputContent":"100.64.0.9"}' ;;
  "ssm get-parameter")
    if [ -f ${secret} ]; then printf '{"Parameter":{"Value":"%s"}}' "$(cat ${secret})"; else echo "An error occurred (ParameterNotFound)" >&2; exit 254; fi ;;
esac`,
  );
  box.stub("session-manager-plugin", "exit 0");
  box.stub("ssh-add", `echo "ssh-add $*" >> ${log}; echo "ecdsa-sha2-nistp256 AAAAfake test@example"`);
  box.stub("ssh", `echo "ssh $*" >> ${log}; [ "$1" = -G ] && echo "hostname i-0abc"; exit 0`);
  box.stub(
    "herdr",
    `echo "herdr $*" >> ${log}
case "$1 $2" in
  "--version ") echo "herdr 0.9.1" ;;
  "machine list") echo '[{"id":"m9","label":"perf-vm-t1","target":"perf-vm-t1"}]' ;;
esac`,
  );
}

// Stands in for the Tailscale and GitHub APIs a launch calls, recording each
// Tailscale request body.
let api: ReturnType<typeof Bun.serve>;
const tailscaleRequests: { path: string; body: string }[] = [];

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/repos/herdrdev/herdr/releases/tags/v0.9.1") {
        return Response.json({
          assets: [{ name: "herdr-linux-aarch64", browser_download_url: "https://example.test/herdr-linux-aarch64", digest: "sha256:feed" }],
        });
      }
      tailscaleRequests.push({ path, body: await request.text() });
      if (path === "/api/v2/oauth/token") return Response.json({ access_token: "token" });
      return Response.json({ key: "tskey-auth-minted" });
    },
  });
});

afterAll(() => api.stop());

// A launch spawns a couple dozen stubs, and a busy machine takes two of them
// past the 5s default.
setDefaultTimeout(30_000);

describe("commands", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox("perf-vm");
    box.mkdir("home");
    stubs(box);
  });

  afterEach(() => box.remove());

  const env = () => ({
    ...process.env,
    PATH: `${box.bin}:${process.env.PATH}`,
    HOME: box.path("home"),
    PERF_VM_PROFILE: "test-profile",
    PERF_VM_TAILSCALE_API: api.url.origin,
    PERF_VM_GITHUB_API: api.url.origin,
  });
  // A synchronous spawn would block the fake APIs, which answer in this process.
  const perf = async (...args: string[]): Promise<Run> => {
    const child = Bun.spawn([perfVm, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { status, stdout, stderr };
  };
  const calls = () => box.read("calls.log");
  const entry = () => box.path("home", ".ssh", "perf-vm", "t1.conf");

  test("launch tags, wires ssh, waits, and registers with herdr", async () => {
    const launched = await perf("launch", "--name", "t1", "--type", "c8g.medium", "--ttl", "30m");
    expect(launched.stderr).not.toContain("does not include");
    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain("instance: i-0abc\n");
    expect(launched.stdout).toContain("herdr-machine: perf-vm-t1\n");

    const log = calls();
    expect(log).toContain("--launch-template LaunchTemplateName=performance --instance-type c8g.medium");
    expect(log).toContain('"Key":"expires-at","Value":"20');
    expect(log).toContain("shutdown -h +$((");
    expect(log).toContain("ecdsa-sha2-nistp256 AAAAfake test@example");
    expect(log).toContain("--profile test-profile --region us-east-1");
    expect(log).toContain("herdr machine add --label perf-vm-t1 perf-vm-t1");
    expect(log).toContain("herdr --machine perf-vm-t1 workspace list");
    expect(box.read("home/.ssh/perf-vm/t1.conf")).toContain("HostName i-0abc");
    expect(launched.stderr).toContain("Session Manager only");
    expect(launched.stdout).toContain("tailnet: none");
    expect(log).not.toContain("tailscale up");
    expect(log).toContain("echo 'feed  /tmp/herdr' | sha256sum -c -");
  });

  test("launch joins the tailnet when the account holds a client secret", async () => {
    box.write("tailscale-secret", "tskey-client-fake");
    tailscaleRequests.length = 0;
    const launched = await perf("launch", "--name", "t1");
    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain("tailnet: 100.64.0.9\n");
    expect(calls()).toContain("tailscale up --auth-key=tskey-auth-minted --hostname=perf-vm-t1 --advertise-tags=tag:perf-vm");
    expect(tailscaleRequests[0].body).toContain("client_secret=tskey-client-fake");
    expect(JSON.parse(tailscaleRequests[1].body).capabilities.devices.create).toEqual({
      reusable: false,
      ephemeral: true,
      preauthorized: true,
      tags: ["tag:perf-vm"],
    });
    const [direct, ssm] = box.read("home/.ssh/perf-vm/t1.conf").split("\n\n");
    expect(direct).toContain("HostName 100.64.0.9");
    expect(ssm).toContain("HostName i-0abc");
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
    expect(row).toMatchObject({ name: "t1", herdr: "perf-vm-t1", type: "c8g.medium", state: "pending" });
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
    expect(resumed.stdout).toContain("herdr-machine: perf-vm-t1\n");
    const log = calls();
    expect(log.indexOf("ec2 create-tags --resources i-0abc --tags Key=expires-at")).toBeLessThan(log.indexOf("ec2 start-instances"));
    expect(log).toContain("shutdown -h +$((");
    expect(log).toContain("herdr --machine perf-vm-t1 workspace list");
    expect(log.indexOf("herdr machine remove m9")).toBeLessThan(log.indexOf("herdr machine add --label perf-vm-t1"));
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
    expect((await perf("resume", "t1", "--ttl", "13h")).stderr).toContain("exceeds the 12h maximum");
  });

  test("extend refuses past 12h after launch", async () => {
    await perf("launch", "--name", "t1");
    const extended = await perf("extend", "t1", "12h");
    expect(extended.status).toBe(2);
    expect(extended.stderr).toContain("passes the 12h limit");
    expect(calls()).not.toContain("create-tags");
  });

  test("destroy terminates and removes the ssh entry and herdr machine", async () => {
    await perf("launch", "--name", "t1");
    const destroyed = await perf("destroy", "t1");
    expect(destroyed.status).toBe(0);
    expect(calls()).toContain("aws ec2 terminate-instances --instance-ids i-0abc");
    expect(calls()).toContain("herdr machine remove m9");
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
});
