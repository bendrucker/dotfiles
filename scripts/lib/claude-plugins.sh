# shellcheck shell=bash
# Sourceable inventory of the Claude Code plugins installed on this machine.
# Shared by bin/claude-upgrade, which updates them, and bin/claude-plugin-audit,
# which checks the update landed.
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
#   Exits non-zero when the inventory could not be read. Callers must check:
#   an unparseable settings.json or a stray line on the CLI's stdout would
#   otherwise read as "no plugins installed", and a job that updates nothing
#   and reports success is the failure this whole file exists to remove.
#
# plugin_source <id>
#   Print the plugin's `source` value, as JSON, from its marketplace manifest.
#   Exits $PLUGIN_SOURCE_UNREADABLE when the manifest is missing, unparseable,
#   or lists the plugin without a source, and $PLUGIN_SOURCE_ABSENT only when
#   the manifest no longer lists the plugin at all. Both are named because two
#   callers branch on them, and only ABSENT means uninstalling is the fix.

PLUGIN_SOURCE_UNREADABLE=3
PLUGIN_SOURCE_ABSENT=4

claude_plugins_dir() {
  printf '%s\n' "$HOME/.claude/plugins"
}

plugin_inventory() {
  local list settings rows id best row_id row_path

  list=$(claude plugin list --json </dev/null 2>/dev/null) || return 1
  [ -n "$list" ] || list='[]'

  settings='{}'
  if [ -f "$HOME/.claude/settings.json" ]; then
    settings=$(cat "$HOME/.claude/settings.json") || return 1
  fi

  rows=$(jq -rn --argjson list "$list" --argjson settings "$settings" '
      [ $list[] | select(.scope == "user") | [.id, .installPath // ""] ]
    + [ ($settings.enabledPlugins // {}) | to_entries[] | select(.value) | [.key, ""] ]
    | .[] | @tsv
  ') || return 1

  # A plugin can hold several records: an uninstall that left its metadata
  # behind writes a duplicate pointing at a path that was never created, and
  # `claude plugin list` prints both. Prefer a payload that exists, and among
  # those one Claude Code has not superseded, since it keeps the directory it
  # replaced around under an .orphaned_at marker.
  printf '%s\n' "$rows" | cut -f1 | sort -u | while IFS= read -r id; do
    [ -n "$id" ] || continue
    best=""
    while IFS=$'\t' read -r row_id row_path; do
      [ "$row_id" = "$id" ] || continue
      [ -n "$row_path" ] || continue
      [ -n "$best" ] || best="$row_path"
      [ -d "$row_path" ] || continue
      best="$row_path"
      [ -e "$row_path/.orphaned_at" ] || break
    done <<EOF
$rows
EOF
    printf '%s\t%s\n' "$id" "$best"
  done
}

plugin_source() {
  local name="${1%@*}" marketplace="${1##*@}" manifest entry source

  manifest="$(claude_plugins_dir)/marketplaces/$marketplace/.claude-plugin/marketplace.json"
  [ -f "$manifest" ] || return "$PLUGIN_SOURCE_UNREADABLE"

  entry=$(jq -c --arg name "$name" \
    'first((.plugins // [])[] | select(.name == $name)) // empty' \
    "$manifest" 2>/dev/null) || return "$PLUGIN_SOURCE_UNREADABLE"
  [ -n "$entry" ] || return "$PLUGIN_SOURCE_ABSENT"

  # Resolved from the entry rather than in one pass, so a plugin listed with no
  # source reads as an unreadable manifest. Collapsing it into ABSENT would skip
  # the plugin in every update and then tell you to uninstall something the
  # marketplace still carries.
  source=$(printf '%s\n' "$entry" | jq -c '.source // empty') ||
    return "$PLUGIN_SOURCE_UNREADABLE"
  [ -n "$source" ] || return "$PLUGIN_SOURCE_UNREADABLE"

  printf '%s\n' "$source"
}
