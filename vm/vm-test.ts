import { dirname } from "node:path";
import type { Mode, Report } from "./guest.ts";
import { testLinux } from "./linux.ts";
import { buildImage, IMAGES, testMacos } from "./macos.ts";
import { errorMessage, log, must, UsageError } from "./process.ts";

const ROOT = dirname(import.meta.dir);

function usage(): string {
  return `Usage: vm-test <--linux|--macos> <fresh|upgrade> [--ref REF]
       vm-test image <clean|oldlayout>

  --linux     Run in an ubuntu:24.04 container under Docker.
  --macos     Run in a macOS VM under tart.
  fresh       Install REF on a machine that has never seen these dotfiles.
  upgrade     Install REF over a machine set up from the old layout.
  --ref REF   The commit to install, from this repo. Defaults to HEAD.

  image clean      Prepare the base macOS image: the vanilla Cirrus image
                   with the Command Line Tools, the guest agent, and
                   passwordless sudo, and no Homebrew.
  image oldlayout  The clean image after one install of the old layout.

The guest checks out a commit, runs scripts/setup twice, and fails when the
second run moves a link. A VM or container that fails is kept and named.`;
}

type Command =
  | { kind: "test"; platform: "linux" | "macos"; mode: Mode; ref: string }
  | { kind: "image"; image: keyof typeof IMAGES };

export function parse(args: string[]): Command {
  if (args[0] === "image") {
    const image = args[1];
    if (args.length !== 2 || (image !== "clean" && image !== "oldlayout")) throw new UsageError("image takes clean or oldlayout");
    return { kind: "image", image };
  }

  let platform: "linux" | "macos" | undefined;
  let mode: Mode | undefined;
  let ref = "HEAD";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--linux" || arg === "--macos") platform = arg === "--linux" ? "linux" : "macos";
    else if (arg === "fresh" || arg === "upgrade") mode = arg;
    else if (arg === "--ref" && args[index + 1]) ref = args[++index];
    else if (arg.startsWith("--ref=")) ref = arg.slice("--ref=".length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (!platform) throw new UsageError("pass --linux or --macos");
  if (!mode) throw new UsageError("pass fresh or upgrade");
  return { kind: "test", platform, mode, ref };
}

function resolve(ref: string): string {
  try {
    return must(["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { capture: true }).trim();
  } catch {
    throw new UsageError(`not a commit: ${ref}`);
  }
}

async function execute(command: Command): Promise<Report> {
  if (command.kind === "image") return buildImage(command.image, ROOT);
  const commit = resolve(command.ref);
  return command.platform === "linux" ? testLinux(command.mode, commit, ROOT) : testMacos(command.mode, commit, ROOT);
}

export async function main(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(usage());
    return 0;
  }
  try {
    const report = await execute(parse(args));
    console.log(`\n${report.format()}`);
    return report.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      log(error.message);
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    log(errorMessage(error));
    return 1;
  }
}
