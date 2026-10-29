import { expect, test } from "bun:test";
import { repoRoot, shell } from "#harness";

function writer(text: string): string {
  return `${process.execPath} -e 'import { writeAll } from "#pipe"; writeAll(1, ${text})'`;
}

test("writes everything through a pipe", () => {
  const result = shell(`${writer('"x".repeat(1 << 20)')} | wc -c`, { cwd: repoRoot });
  expect(result.stdout.trim()).toBe(String(1 << 20));
});

test("returns quietly when the reader goes away", () => {
  const result = shell(`${writer('"x\\n".repeat(1e6)')} | head -1; echo "\${PIPESTATUS[0]}"`, { cwd: repoRoot });
  expect(result.stdout).toBe("x\n0\n");
  expect(result.stderr).toBe("");
});
