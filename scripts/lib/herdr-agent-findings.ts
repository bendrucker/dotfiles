// A finding and the key its to-do latches on.
//
// The two are not the same string. A finding says what is wrong in the terms
// that make it actionable, which for this job means naming the manifest version
// or the Claude Code release the machine is running. Those move on their own,
// with nobody having acted on the finding, so latching on the message refiles
// the same unaddressed to-do every time one ships. The key holds the part that
// identifies the finding: the rule ids that disagree, the minor version the
// screens fell behind at.

export type Finding = { message: string; key: string };

// The message doubles as the key wherever nothing in it moves on its own, which
// is most findings here.
export function finding(message: string, key: string = message): Finding {
  return { message, key };
}

// Sorted, because the set is the thing and the order it was collected in is not.
// By code unit rather than by locale, so the key a machine writes does not
// depend on the locale the job happened to run under.
export function fingerprintOf(findings: Finding[]): string {
  return findings
    .map((found) => found.key)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(" ");
}
