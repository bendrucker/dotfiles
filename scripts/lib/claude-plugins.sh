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
# plugin_source <id>
#   Print the plugin's `source` value, as JSON, from its marketplace manifest.
#   Exit 3 when the marketplace has no readable manifest, 4 when the manifest no
#   longer lists the plugin.

claude_plugins_dir() {
  printf '%s\n' "$HOME/.claude/plugins"
}

plugin_inventory() {
  local list settings rows id best row_id row_path

  list=$(claude plugin list --json 2>/dev/null)
  [ -n "$list" ] || list='[]'

  settings='{}'
  [ -f "$HOME/.claude/settings.json" ] && settings=$(cat "$HOME/.claude/settings.json")

  rows=$(jq -rn --argjson list "$list" --argjson settings "$settings" '
      [ $list[] | select(.scope == "user") | [.id, .installPath // ""] ]
    + [ ($settings.enabledPlugins // {}) | to_entries[] | select(.value) | [.key, ""] ]
    | .[] | @tsv
  ' 2>/dev/null) || return 1

  # A plugin can hold several records: an uninstall that left its metadata
  # behind writes a duplicate pointing at a path that was never created, and
  # `claude plugin list` prints both. The payload that exists is the real one.
  printf '%s\n' "$rows" | cut -f1 | sort -u | while IFS= read -r id; do
    [ -n "$id" ] || continue
    best=""
    while IFS=$'\t' read -r row_id row_path; do
      [ "$row_id" = "$id" ] || continue
      [ -n "$row_path" ] || continue
      [ -n "$best" ] || best="$row_path"
      if [ -d "$row_path" ]; then
        best="$row_path"
        break
      fi
    done <<EOF
$rows
EOF
    printf '%s\t%s\n' "$id" "$best"
  done
}

plugin_source() {
  local id="$1" name="${1%@*}" marketplace="${1##*@}" manifest source

  manifest="$(claude_plugins_dir)/marketplaces/$marketplace/.claude-plugin/marketplace.json"
  [ -f "$manifest" ] || return 3

  source=$(jq -c --arg name "$name" \
    'first((.plugins // [])[] | select(.name == $name) | .source) // empty' \
    "$manifest" 2>/dev/null) || return 3
  [ -n "$source" ] || return 4

  printf '%s\n' "$source"
}
