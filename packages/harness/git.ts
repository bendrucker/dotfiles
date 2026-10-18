/**
 * Commit `files` onto `branch` of the repository at `gitDir`, as though a
 * clone had committed them and pushed.
 */
export function landCommit(gitDir: string, files: Record<string, string>, message: string, branch = "main"): void {
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const stream = [
    `commit refs/heads/${branch}\n`,
    `committer Spec <spec@example.test> ${Math.floor(Date.now() / 1000)} +0000\n`,
    data(message),
    `from refs/heads/${branch}^0\n`,
    ...Object.entries(files).map(([path, contents]) => `M 100644 inline ${path}\n${data(contents)}`),
  ].join("");

  const result = Bun.spawnSync({
    cmd: ["git", "--git-dir", gitDir, "fast-import", "--quiet"],
    stdin: Buffer.from(stream),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git fast-import exited ${result.exitCode}: ${result.stderr.toString()}`);
}
