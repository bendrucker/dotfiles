import { readFileSync } from "node:fs";
import { join } from "node:path";
import { converge, gitCommonDir, type Guest, type Mode, OLDLAYOUT_COMMIT, Report, verify } from "./guest.ts";
import { errorMessage, type Exit, log, must, randomName, run } from "./process.ts";

// The release the CI Linux job runs on, through ubuntu-latest.
const IMAGE = "ubuntu:24.04";
const CACHE_VOLUME = "vm-test-homebrew";
const HOME = "/home/runner";
const GUEST_PATH = "/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const SKIPPED = ["casks, mas, services: skipped under CI, as in the CI job", "defaults, launchd: macOS only"];

class Container implements Guest {
  readonly share = "/src";

  constructor(readonly name: string) {}

  exec(cmd: string[], options: { stdin?: Uint8Array; capture?: boolean } = {}): Exit {
    // CI is what the root Brewfile keys on to skip casks and services, which
    // it would otherwise attempt on Linux too.
    // A bare name passes the host's value without putting it on the command line.
    const token = process.env.GITHUB_TOKEN ? ["GITHUB_TOKEN"] : [];
    const env = [`HOME=${HOME}`, `PATH=${GUEST_PATH}`, "LANG=C.UTF-8", "USER=runner", "CI=true", ...token].flatMap((pair) => ["--env", pair]);
    const interactive = options.stdin ? ["--interactive"] : [];
    return run(["docker", "exec", ...interactive, "--user", "runner", "--workdir", HOME, ...env, this.name, ...cmd], options);
  }
}

function exercise(container: Container, report: Report, mode: Mode, commit: string): void {
  const prepare = new Uint8Array(readFileSync(join(import.meta.dir, "guest", "ubuntu.sh")));
  if (!report.phase("prepare runner", () => run(["docker", "exec", "--interactive", container.name, "bash", "-s"], { stdin: prepare }).status === 0)) return;
  if (mode === "upgrade" && !converge(container, report, OLDLAYOUT_COMMIT)) return;
  if (converge(container, report, commit)) verify(container, report);
}

/** Converge a fresh ubuntu container onto `commit`, by way of the old layout for an upgrade. */
export function testLinux(mode: Mode, commit: string, root: string): Report {
  const name = randomName();
  const report = new Report(`vm-test --linux ${mode} ${commit.slice(0, 8)} (${name})`, SKIPPED);
  try {
    must([
      "docker", "run", "--detach", "--name", name,
      "--volume", `${gitCommonDir(root)}:/src:ro`,
      "--volume", `${CACHE_VOLUME}:${HOME}/.cache/Homebrew`,
      IMAGE, "sleep", "infinity",
    ], { capture: true });
    exercise(new Container(name), report, mode, commit);
  } catch (error) {
    log(errorMessage(error));
    report.fail("error");
  }
  if (report.passed) run(["docker", "rm", "--force", name], { capture: true });
  else log(`kept ${name} for inspection: docker exec -it --user runner ${name} zsh, then docker rm -f ${name}`);
  return report;
}
