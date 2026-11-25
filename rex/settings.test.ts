import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, stubGum, type Run, type Sandbox } from "#harness";
import { recorded, recordingStub } from "#harness/recorder";

const script = join(repoRoot, "rex", "settings.ts");
const settings: Record<string, unknown> = JSON.parse(readFileSync(join(repoRoot, "rex", "settings.json"), "utf8"));
const actionNames = Object.keys(settings).map((key) => `client.setting.${key}`);

let box: Sandbox;

beforeEach(() => {
  box = sandbox("rex-settings");
  stubGum(box);
  // `client ls` answers clients.json, or fails without one, as with no server.
  // `do` fails generically when `refuse` exists, and rejects the value of the
  // action named in `reject`.
  recordingStub(
    box,
    "rex",
    [
      `dir='${box.dir}'`,
      'case "$*" in',
      '  *"client ls"*) [ -f "$dir/clients.json" ] || exit 1; cat "$dir/clients.json" ;;',
      '  *" actions --json"*) cat "$dir/actions.json" ;;',
      '  *" do "*)',
      '    if [ -f "$dir/refuse" ]; then echo "Error: remote control is off" >&2; exit 1; fi',
      '    if [ -f "$dir/reject" ] && [ "$5" = "$(cat "$dir/reject")" ]; then echo "Error: bad value (invalid_value)" >&2; exit 1; fi',
      "    ;;",
      "esac",
    ].join("\n"),
  );
});

afterEach(() => {
  box.remove();
});

function connect(...clients: object[]): void {
  box.write("clients.json", JSON.stringify({ clients }));
}

function offer(names: string[]): void {
  box.write("actions.json", JSON.stringify({ actions: names.map((name) => ({ name })) }));
}

const mac = { client_id: "client:mac", info: { kind: "app", platform: "macos", label: "Studio" } };

function apply(): Run {
  return run([process.execPath, script], { path: [box.bin], env: { HOME: box.path("home") } });
}

function applied(): string[][] {
  return recorded(box).filter((call) => call.includes("do"));
}

describe("rex settings", () => {
  test("sets each setting on the Mac app with an explicit value", () => {
    connect(mac, { client_id: "client:cli" }, { client_id: "client:hook", info: { kind: "other" } });
    offer(actionNames);

    const result = apply();

    expect(result.status).toBe(0);
    expect(applied()).toEqual(
      Object.entries(settings).map(([key, value]) => [
        "rex",
        "--autostart=false",
        "-C",
        "client:mac",
        "do",
        `client.setting.${key}`,
        "--args",
        JSON.stringify({ value }),
        "--timeout",
        "10s",
      ]),
    );
  });

  test.each<{ name: string; clients?: object[]; message: string }>([
    { name: "the server isn't running", message: "server not running" },
    {
      name: "only an iOS app is connected",
      clients: [{ client_id: "client:ios", info: { kind: "app", platform: "ios" } }],
      message: "no Mac app connected",
    },
  ])("skips when $name", ({ clients, message }) => {
    if (clients !== undefined) connect(...clients);

    const result = apply();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(message);
    expect(applied()).toEqual([]);
  });

  test("skips an action the app doesn't offer", () => {
    connect(mac);
    const [missing, ...rest] = actionNames;
    offer(rest);

    const result = apply();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`Studio has no ${missing}`);
    expect(applied()).toHaveLength(rest.length);
  });

  test("keeps going past a rejected value", () => {
    connect(mac);
    offer(actionNames);
    box.write("reject", actionNames[0] ?? "");

    const result = apply();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`Studio rejected ${actionNames[0]}`);
    expect(applied()).toHaveLength(actionNames.length);
  });

  test("stops at the first refusal and still exits 0", () => {
    connect(mac);
    offer(actionNames);
    box.write("refuse", "");

    const result = apply();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("remote control is off");
    expect(applied()).toHaveLength(1);
  });
});
