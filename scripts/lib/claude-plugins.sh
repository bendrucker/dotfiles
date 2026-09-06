# shellcheck shell=bash
# Sourceable inventory of the Claude Code plugins installed on this machine.
# bin/claude-plugins holds the logic. These functions exist so the shell callers
# keep the contract they were written against: bin/claude-upgrade, which updates
# the plugins, and bin/claude-plugin-audit, which checks the update landed.
#
# claude_plugins_dir
#   Root of the plugin state directory.
#
# plugin_inventory
#   Print "<id>\t<installPath>" for every user-scope plugin, one per line.
#   The rows are the union of what `claude plugin list` reports and the plugins
#   settings.json enables, so a plugin enabled but never installed still
#   appears, with an empty installPath. A plugin enabled by a project or a
#   settings.local.json is out of scope: `claude plugin update` works at user
#   scope, so those are not this job's to update.
#
#   Exits non-zero when the inventory could not be read, naming the cause on
#   stderr. Callers must check: an unparseable settings.json or a stray line on
#   the CLI's stdout would otherwise read as "no plugins installed", and a job
#   that updates nothing and reports success is the failure this whole file
#   exists to remove.
#
# plugin_source <id>
#   Print the plugin's `source` value, as JSON, from its marketplace manifest.
#   Exits $PLUGIN_SOURCE_UNREADABLE when the manifest is missing, unparseable,
#   or lists the plugin without a source, and $PLUGIN_SOURCE_ABSENT only when
#   the manifest no longer lists the plugin at all. Both are named because two
#   callers branch on them, and only ABSENT means uninstalling is the fix.

# The exit codes bin/claude-plugins gives the two conditions, named here because
# the callers compare against them numerically after sourcing this.
# shellcheck disable=SC2034
PLUGIN_SOURCE_UNREADABLE=3
# shellcheck disable=SC2034
PLUGIN_SOURCE_ABSENT=4

# Sourced by both zsh and bash callers, so the file's own path comes from
# whichever of the two records it: bash keeps it in BASH_SOURCE, zsh puts it in
# $0 for the duration of the source. Resolved here rather than in the functions,
# because neither name survives into a call.
if [ -n "${BASH_SOURCE:-}" ]; then
  _claude_plugins_lib="${BASH_SOURCE[0]}"
else
  _claude_plugins_lib="$0"
fi
_claude_plugins_bin="$(cd "$(dirname "$_claude_plugins_lib")/../../bin" && pwd)/claude-plugins"

claude_plugins_dir() {
  "$_claude_plugins_bin" dir
}

plugin_inventory() {
  "$_claude_plugins_bin" inventory
}

plugin_source() {
  "$_claude_plugins_bin" source "$1"
}
