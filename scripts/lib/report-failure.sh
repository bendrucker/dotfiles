# shellcheck shell=bash
# Sourceable failure reporting for unattended jobs. bin/report-failure holds the
# logic. These functions exist so the shell callers keep the positional contract
# they were written against.
#
# notify <title> <message> [sound]
#   Raise a notification through osascript, where there is one to raise it
#   (default sound: Basso).
#
# report_failure <job> <title> <command> <output> <revision> [extra_meta] [output_heading] [fingerprint]
#   File a Things to-do describing the failure and notify, but only on the
#   transition into a failed state. A per-job latch under
#   ${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/<job>.status records ok
#   or failed; while a job stays broken the latch suppresses duplicate
#   to-dos. report_success resets it so the next break files a fresh one.
#   <command> is the shell snippet shown in the to-do for reproduction;
#   <output> is the captured log; <extra_meta> is optional extra metadata
#   markdown appended to the host/time/revision header; <output_heading> names
#   the section holding <output>, for a job whose output is a finding list
#   rather than an error (default: "Error Output").
#
#   <fingerprint> is an optional summary of what is wrong, stored in the latch.
#   A job that reports a set of findings rather than one failure needs it: with
#   a plain latch, the first standing finding suppresses every finding that
#   appears after it, however long it stands. When the fingerprint changes the
#   latch reopens and a fresh to-do names the new set.
#
#   <output> is trimmed to fit the notes field, keeping its end.
#
# report_success <job>
#   Clear the latch.

# Sourced by both zsh and bash callers, so the file's own path comes from
# whichever of the two records it: bash keeps it in BASH_SOURCE, zsh puts it in
# $0 for the duration of the source. Resolved here rather than in the functions,
# because neither name survives into a call.
if [ -n "${BASH_SOURCE:-}" ]; then
  _report_failure_lib="${BASH_SOURCE[0]}"
else
  _report_failure_lib="$0"
fi
_report_failure_bin="$(cd "$(dirname "$_report_failure_lib")/../../bin" && pwd)/report-failure"

# Every value travels in the --flag=value form. A value beginning with a dash is
# otherwise taken for the next flag and the CLI aborts before it has filed
# anything: claude-upgrade's extra metadata opens with a markdown bullet, and a
# captured log can open with anything at all.
notify() {
  if [ -n "${3:-}" ]; then
    "$_report_failure_bin" notify --title="$1" --message="$2" --sound="$3"
  else
    "$_report_failure_bin" notify --title="$1" --message="$2"
  fi
}

report_success() {
  "$_report_failure_bin" success --job="$1"
}

report_failure() {
  "$_report_failure_bin" failure \
    --job="$1" \
    --title="$2" \
    --command="$3" \
    --output="$4" \
    --revision="$5" \
    --extra-meta="${6:-}" \
    --output-heading="${7:-Error Output}" \
    --fingerprint="${8:-}"
}
