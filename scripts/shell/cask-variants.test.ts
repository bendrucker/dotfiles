import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quote, repoRoot, shell } from "#harness";

const lib = join(repoRoot, "scripts", "shell", "cask-variants.sh");

function caskVariantsSuperseded(declared: string, installed: string) {
  return shell(`. ${quote(lib)}\ncask_variants_superseded "$1" "$2"`, { args: [declared, installed] });
}

describe("cask-variants.sh", () => {
  describe("cask_variants_superseded", () => {
    test("pairs an installed cask with the declared variant that replaces it", () => {
      const r = caskVariantsSuperseded("ghostty@tip", "ghostty");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("ghostty\tghostty@tip");
    });

    test("retires a variant when the Brewfile moves back to the plain cask", () => {
      const r = caskVariantsSuperseded("ghostty", "ghostty@tip");
      expect(r.stdout.trim()).toBe("ghostty@tip\tghostty");
    });

    test("leaves a cask alone while it is still declared", () => {
      const r = caskVariantsSuperseded("ghostty@tip", "ghostty@tip");
      expect(r.stdout.trim()).toBe("");
    });

    test("ignores an installed cask with no declared sibling", () => {
      const r = caskVariantsSuperseded("ghostty@tip", "rancher");
      expect(r.stdout.trim()).toBe("");
    });

    // docker-desktop declares conflicts_with rancher, but they share no base
    // token, so the variant rule must not select it.
    test("does not treat a conflicting unrelated app as a sibling", () => {
      const r = caskVariantsSuperseded("docker-desktop", "rancher");
      expect(r.stdout.trim()).toBe("");
    });

    test("matches on the whole base token, not a prefix", () => {
      const r = caskVariantsSuperseded("docker-desktop", "docker");
      expect(r.stdout.trim()).toBe("");
    });

    test("selects only the superseded entries out of a mixed list", () => {
      const declared = "ghostty@tip\nclaude-code@latest\nfirefox";
      const installed = "ghostty\nfirefox\nclaude-code";

      const r = caskVariantsSuperseded(declared, installed);
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines[0]).toBe("ghostty\tghostty@tip");
      expect(lines[1]).toBe("claude-code\tclaude-code@latest");
      expect(lines).toHaveLength(2);
    });

    test("handles an empty installed list", () => {
      const r = caskVariantsSuperseded("ghostty@tip", "");
      expect(r.stdout.trim()).toBe("");
    });
  });
});
