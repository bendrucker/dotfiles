#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the two invariants a silent plugin upgrade failure broke: every
# installed plugin is enumerated for update, and a plugin that did not end up
# matching its marketplace is reported. Both regressions were invisible from the
# outside, because the upgrade kept exiting 0 while installs sat months behind.
#
# The functions are exercised by sourcing bin/claude-upgrade and
# bin/claude-plugin-audit under their ZSH_EVAL_CONTEXT guard, which defines them
# without running the upgrade. PATH-shim stubs for claude/gum/git feed canned
# plugin metadata to the real code, following claude_prune_agents_spec.sh.

upgrade="$SHELLSPEC_PROJECT_ROOT/../bin/claude-upgrade"
audit="$SHELLSPEC_PROJECT_ROOT/../bin/claude-plugin-audit"

# The commit every fixture install records, and by default the one the stubbed
# remote reports, so a repo-backed plugin starts out current.
recorded_sha="1111111111111111111111111111111111111111"

setup() {
  sandbox="$SHELLSPEC_TMPBASE/claude-upgrade"
  stubdir="$sandbox/stub"
  plugins="$sandbox/.claude/plugins"
  rm -rf "$sandbox"
  mkdir -p "$stubdir" "$plugins"

  export HOME="$sandbox"
  export CLAUDE_PLUGIN_LOG="$sandbox/plugin.log"
  export CLAUDE_UPDATE_FAILS=""
  : >"$CLAUDE_PLUGIN_LOG"

  # alpha ships its own .claude-plugin and matches its marketplace, down to the
  # .in_use marker Claude Code writes into the payload at runtime.
  write_plugin alpha first "$plugins/cache/first/alpha/1.0.0"
  mkdir -p "$plugins/marketplaces/first/plugins/alpha/.claude-plugin"
  printf '{"name":"alpha"}\n' >"$plugins/marketplaces/first/plugins/alpha/.claude-plugin/plugin.json"
  cp -R "$plugins/marketplaces/first/plugins/alpha/." "$plugins/cache/first/alpha/1.0.0/"
  : >"$plugins/cache/first/alpha/1.0.0/.in_use"

  # beta ships no .claude-plugin, so Claude Code synthesizes one into the
  # payload, and its dependencies land there as node_modules. Neither comes from
  # the marketplace, and neither is drift.
  write_plugin beta third "$plugins/cache/third/beta/abc123"
  mkdir -p "$plugins/marketplaces/third/plugins/beta"
  printf 'beta\n' >"$plugins/marketplaces/third/plugins/beta/README.md"
  cp -R "$plugins/marketplaces/third/plugins/beta/." "$plugins/cache/third/beta/abc123/"
  mkdir -p "$plugins/cache/third/beta/abc123/.claude-plugin" \
    "$plugins/cache/third/beta/abc123/node_modules/dep"
  printf '{"name":"beta"}\n' >"$plugins/cache/third/beta/abc123/.claude-plugin/plugin.json"

  # gamma carries a second record left behind by an uninstall, pointing at a
  # payload directory that was never created.
  write_plugin gamma first "$plugins/cache/first/gamma/1.0.0" "$plugins/cache/first/gamma/unknown"
  mkdir -p "$plugins/marketplaces/first/plugins/gamma"
  printf 'gamma\n' >"$plugins/marketplaces/first/plugins/gamma/README.md"
  cp -R "$plugins/marketplaces/first/plugins/gamma/." "$plugins/cache/first/gamma/1.0.0/"

  # delta lives in its own repo, so it is checked against the commit that repo
  # currently points at.
  write_plugin delta third "$plugins/cache/third/delta/1.0.0" \
    '{"source":"github","repo":"example/delta"}'

  write_marketplace first alpha gamma
  write_marketplace third beta delta
  write_settings alpha@first beta@third gamma@first delta@third
  write_known_marketplaces
  write_plugin_list

  cat >"$stubdir/claude" <<'CLAUDE'
#!/usr/bin/env bash
case "$2" in
  list)   cat "$HOME/plugin-list.json" ;;
  update)
    printf 'update %s\n' "$3" >>"$CLAUDE_PLUGIN_LOG"
    case " $CLAUDE_UPDATE_FAILS " in *" $3 "*) exit 1 ;; esac
    ;;
  install) printf 'install %s\n' "$3" >>"$CLAUDE_PLUGIN_LOG" ;;
esac
exit 0
CLAUDE
  chmod +x "$stubdir/claude"

  # Only ls-remote and rev-parse are stubbed; the audit uses git for nothing else.
  cat >"$stubdir/git" <<'GIT'
#!/usr/bin/env bash
case "$1" in
  ls-remote) printf '%s\trefs/heads/main\n' "$REMOTE_SHA" ;;
  -C)        [ "$3" = "rev-parse" ] && printf '%s\n' "$CLONE_SHA" ;;
esac
exit 0
GIT
  chmod +x "$stubdir/git"
  export REMOTE_SHA="$recorded_sha"
  export CLONE_SHA="$recorded_sha"

  printf '#!/usr/bin/env bash\nexit 0\n' >"$stubdir/gum"
  chmod +x "$stubdir/gum"
}

# Record a plugin's install metadata. Extra arguments are either further
# installPaths (duplicate records) or, when JSON, the plugin's marketplace
# source. A source implies the install is tracked by commit.
write_plugin() {
  local name="$1" marketplace="$2" path="$3"
  shift 3
  printf '%s\t%s\t%s\n' "$name" "$marketplace" "$path" >>"$sandbox/plugins.tsv"
  mkdir -p "$path"
  local extra
  for extra in "$@"; do
    case "$extra" in
      '{'*) printf '%s\t%s\n' "$path" "$extra" >>"$sandbox/sources.tsv" ;;
      *)    printf '%s\t%s\t%s\n' "$name" "$marketplace" "$extra" >>"$sandbox/plugins.tsv" ;;
    esac
  done
}

write_marketplace() {
  local marketplace="$1" name entries=""
  shift
  for name in "$@"; do
    local source="\"./plugins/$name\""
    grep -q "/$marketplace/$name/" "$sandbox/sources.tsv" 2>/dev/null &&
      source=$(grep "/$marketplace/$name/" "$sandbox/sources.tsv" | cut -f2)
    entries="$entries{\"name\":\"$name\",\"source\":$source},"
  done
  mkdir -p "$plugins/marketplaces/$marketplace/.claude-plugin"
  printf '{"name":"%s","plugins":[%s]}\n' "$marketplace" "${entries%,}" \
    >"$plugins/marketplaces/$marketplace/.claude-plugin/marketplace.json"
}

write_settings() {
  local id keys=""
  for id in "$@"; do keys="$keys\"$id\":true,"; done
  mkdir -p "$HOME/.claude"
  printf '{"enabledPlugins":{%s,"disabled@first":false}}\n' "${keys%,}" \
    >"$HOME/.claude/settings.json"
}

# first is a git clone, so its freshness is checkable. third is materialized
# from a tarball and has no clone to read.
write_known_marketplaces() {
  mkdir -p "$plugins/marketplaces/first/.git"
  jq -n --arg plugins "$plugins" '
    ["first", "third"]
    | map({
        key: .,
        value: {
          source: {source: "github", repo: ("example/" + .)},
          installLocation: ($plugins + "/marketplaces/" + .)
        }
      })
    | from_entries
  ' >"$plugins/known_marketplaces.json"
}

# Render the fixture rows into what `claude plugin list --json` reports and what
# installed_plugins.json records, so the two always agree.
write_plugin_list() {
  awk -F'\t' 'BEGIN { print "[" } {
    printf "%s{\"id\":\"%s@%s\",\"scope\":\"user\",\"enabled\":true,\"installPath\":\"%s\"}\n",
      (NR > 1 ? "," : ""), $1, $2, $3
  } END { print "]" }' "$sandbox/plugins.tsv" >"$HOME/plugin-list.json"

  awk -F'\t' -v sha="$recorded_sha" 'BEGIN { print "[{\"key\":\"plugins\",\"value\":{" } {
    printf "%s\"%s@%s\":[{\"installPath\":\"%s\",\"gitCommitSha\":\"%s\"}]\n",
      (NR > 1 ? "," : ""), $1, $2, $3, sha
  } END { print "}}]" }' "$sandbox/plugins.tsv" >"$plugins/installed_plugins.json"
}

# An installed plugin its marketplace stopped offering. Nothing can update it,
# so the update pass has to leave it alone and the audit has to name it.
add_orphan() {
  write_plugin ghost first "$plugins/cache/first/ghost/1.0.0"
  write_plugin_list
}

BeforeEach 'setup'

# `zsh -f` skips ~/.zshenv, which after bootstrap re-runs `brew shellenv` and
# reorders PATH, pushing $stubdir below a real claude/git and shadowing the stubs.
call_upgrade() { PATH="$stubdir:$PATH" zsh -fc 'source "$1"; shift; "$@"' _ "$upgrade" "$@"; }
run_audit() { PATH="$stubdir:$PATH" zsh -f "$audit"; }
inventory_ids() { call_upgrade plugin_inventory | cut -f1 | paste -sd, -; }

Describe "plugin enumeration"
  # The filter this replaced kept only ids ending in the first-party marketplace
  # name, so every third-party plugin went unattempted for months.
  It "includes plugins from every marketplace"
    When call call_upgrade plugin_inventory
    The status should be success
    The output should include "alpha@first"
    The output should include "beta@third"
  End

  It "emits one row per plugin"
    When call inventory_ids
    The status should be success
    The output should equal "alpha@first,beta@third,delta@third,gamma@first"
  End

  # settings.json records a plugin turned off as a false value rather than
  # dropping the key, so reading the keys alone would install it.
  It "leaves out a plugin settings.json turned off"
    When call inventory_ids
    The status should be success
    The output should not include "disabled@first"
  End

  It "points a duplicated plugin at the payload that exists"
    When call call_upgrade plugin_inventory
    The status should be success
    The output should include "cache/first/gamma/1.0.0"
    The output should not include "gamma/unknown"
  End
End

Describe "update_plugins"
  It "updates every installed plugin"
    When call call_upgrade update_plugins
    The status should be success
    The contents of file "$CLAUDE_PLUGIN_LOG" should include "update alpha@first"
    The contents of file "$CLAUDE_PLUGIN_LOG" should include "update beta@third"
  End

  # Counting failures and returning 0 is what let a machine where every update
  # failed still report success and file no to-do.
  It "fails when an update fails"
    export CLAUDE_UPDATE_FAILS="beta@third"
    When call call_upgrade update_plugins
    The status should be failure
  End

  It "leaves a plugin its marketplace dropped alone"
    add_orphan
    When call call_upgrade update_plugins
    The status should be success
    The contents of file "$CLAUDE_PLUGIN_LOG" should not include "ghost@first"
  End
End

Describe "claude-plugin-audit"
  It "passes when every payload matches its marketplace"
    When call run_audit
    The status should be success
    The output should include "5 checks current"
  End

  # The marketplace clones are what every payload is compared against, and
  # `claude plugin marketplace update` only warns when it fails.
  It "flags a marketplace clone behind its source"
    export CLONE_SHA="3333333333333333333333333333333333333333"
    When call run_audit
    The status should be failure
    The output should include "marketplace/first"
    The output should include "stale"
  End

  # A comparison that could not be made is a flaky network far more often than
  # a real change, so failing on one would file a to-do the next run clears.
  It "reports what it cannot verify without failing"
    When call run_audit
    The status should be success
    The output should include "marketplace/third"
    The output should include "unverified"
  End

  It "flags a payload that lost a file"
    rm "$plugins/cache/third/beta/abc123/README.md"
    When call run_audit
    The status should be failure
    The output should include "beta@third"
    The output should include "stale"
  End

  # A plugin that ships its own .claude-plugin stays compared. Excluding the
  # directory outright to spare the plugins Claude Code synthesizes one for
  # would blind the audit to every manifest change.
  It "flags a payload whose manifest fell behind"
    printf '{"name":"alpha","version":"2"}\n' \
      >"$plugins/marketplaces/first/plugins/alpha/.claude-plugin/plugin.json"
    When call run_audit
    The status should be failure
    The output should include "alpha@first"
    The output should include "stale"
  End

  It "flags a payload behind the commit its repo points at"
    export REMOTE_SHA="2222222222222222222222222222222222222222"
    When call run_audit
    The status should be failure
    The output should include "delta@third"
    The output should include "222222222222"
  End

  It "flags a plugin its marketplace dropped"
    add_orphan
    When call run_audit
    The status should be failure
    The output should include "ghost@first"
    The output should include "orphaned"
  End
End
