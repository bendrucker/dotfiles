import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run, sandbox, type Sandbox } from "#harness";

const script = join(repoRoot, "bin", "git-ssh-sign");
const secretive = "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh";

let box: Sandbox;

beforeEach(() => {
  box = sandbox("git-ssh-sign");
  box.stub("ssh-keygen", 'echo "$SSH_AUTH_SOCK $*"');
});

afterEach(() => box.remove());

function sign() {
  return run([script, "-Y", "sign", "-n", "git"], {
    path: [box.bin],
    env: { HOME: box.dir, SSH_AUTH_SOCK: "/herdr.sock.agent" },
  });
}

describe("git-ssh-sign", () => {
  test("signs through Secretive when its socket exists", () => {
    // A socket path is capped near 104 bytes, so the container path links to
    // a short one.
    const listener = Bun.listen({ unix: box.path("s"), socket: { data() {} } });
    try {
      box.mkdir(join(secretive, ".."));
      symlinkSync(box.path("s"), box.path(secretive));
      expect(sign().stdout.trim()).toBe(`${box.path(secretive)} -Y sign -n git`);
    } finally {
      listener.stop(true);
    }
  });

  test("keeps the inherited agent without Secretive", () => {
    expect(sign().stdout.trim()).toBe("/herdr.sock.agent -Y sign -n git");
  });
});
