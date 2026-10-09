import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "scripts", "brew-leave-self-updating");

let box: Sandbox;

beforeEach(() => {
  box = sandbox("brew-leave-self-updating");
  box.stub("uname", "echo Darwin");
});

afterEach(() => {
  box.remove();
});

describe("brew-leave-self-updating", () => {
  test.each<{ name: string; job?: string; managed: boolean; status: number }>([
    { name: "the nightly job on an unmanaged machine leaves them", job: "dotfiles-upgrade", managed: false, status: 0 },
    { name: "a hand run on an unmanaged machine upgrades them", managed: false, status: 1 },
    { name: "another job on an unmanaged machine upgrades them", job: "dotfiles-sync", managed: false, status: 1 },
    { name: "a hand run on a managed machine leaves them", managed: true, status: 0 },
  ])("$name", ({ job, managed, status }) => {
    const dir = box.mkdir("managed");
    if (managed) box.write("managed/com.example.plist", "");

    const result = run([script, dir], { path: [box.bin], env: { DOTFILES_JOB: job } });

    expect(result.status).toBe(status);
  });
});
