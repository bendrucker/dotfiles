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
[ -n "$CLAUDE_DRAINS_STDIN" ] && cat >/dev/null
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
  export CLAUDE_DRAINS_STDIN=""

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

write_known_marketplaces() {
  mkdir -p "$plugins/marketplaces/first/.git" "$plugins/marketplaces/third/.git"
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

# A plugin the marketplace still carries but no longer says where to get. The
# marketplace has not dropped it, so uninstalling is the wrong answer.
drop_source() {
  local name="$1" marketplace="$2"
  local manifest="$plugins/marketplaces/$marketplace/.claude-plugin/marketplace.json"
  jq --arg name "$name" \
    '.plugins |= map(if .name == $name then del(.source) else . end)' \
    "$manifest" >"$manifest.next" && mv "$manifest.next" "$manifest"
}

# A marketplace Claude Code materialized from GCS. It has no .git, and records
# the commit it was built from in .gcs-sha, written without a trailing newline.
materialize_marketplace() {
  local marketplace="$1" sha="$2"
  rm -rf "$plugins/marketplaces/$marketplace/.git"
  printf '%s' "$sha" >"$plugins/marketplaces/$marketplace/.gcs-sha"
}

# A single-plugin marketplace, whose whole tree is the payload. The install gets
# the tree without the provenance marker, which belongs to the marketplace.
root_source() {
  local name="$1" marketplace="$2" payload="$3"
  local manifest="$plugins/marketplaces/$marketplace/.claude-plugin/marketplace.json"
  jq --arg name "$name" \
    '.plugins |= map(if .name == $name then .source = "." else . end)' \
    "$manifest" >"$manifest.next" && mv "$manifest.next" "$manifest"
  rm -rf "$payload"
  cp -R "$plugins/marketplaces/$marketplace" "$payload"
  rm -f "$payload/.gcs-sha" "$payload/.git"
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

  # Only a marketplace that stopped listing the plugin is beyond updating. One
  # that lists it without saying where it comes from still carries it, and
  # skipping those is how a plugin stops being updated for good.
  It "keeps updating a plugin listed without a source"
    drop_source alpha first
    When call call_upgrade update_plugins
    The status should be success
    The contents of file "$CLAUDE_PLUGIN_LOG" should include "update alpha@first"
  End

  # The loop's stdin is the inventory. One CLI invocation that reads stdin would
  # swallow the rest of it and leave every plugin after it unattempted, with
  # nothing in the exit status to say so.
  It "updates every plugin even when the CLI reads stdin"
    export CLAUDE_DRAINS_STDIN=1
    When call call_upgrade update_plugins
    The status should be success
    The contents of file "$CLAUDE_PLUGIN_LOG" should include "update alpha@first"
    The contents of file "$CLAUDE_PLUGIN_LOG" should include "update gamma@first"
  End

  # An inventory that could not be read is not an empty one: updating nothing
  # and reporting success is the failure this job exists to make loud.
  It "fails when the inventory cannot be read"
    printf 'not json\n' >"$HOME/.claude/settings.json"
    When call call_upgrade update_plugins
    The status should be failure
    The contents of file "$CLAUDE_PLUGIN_LOG" should equal ""
    # jq's own complaint reaches the captured log, so the to-do names the cause.
    The stderr should be defined
  End
End

Describe "claude-plugin-audit"
  It "passes when every payload matches its marketplace"
    When call run_audit
    The status should be success
    The output should include "6 checks current"
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

  # Claude Code materializes some marketplaces from GCS, leaving the source
  # commit in .gcs-sha. Treating those as unverifiable demoted every plugin
  # served by the official marketplace along with it.
  It "vouches for a GCS marketplace whose recorded sha matches its source"
    materialize_marketplace first "$recorded_sha"
    When call run_audit
    The status should be success
    The output should include "6 checks current"
  End

  It "flags a GCS marketplace behind its source"
    materialize_marketplace first "3333333333333333333333333333333333333333"
    When call run_audit
    The status should be failure
    The output should include "marketplace/first"
    The output should include "stale"
    The output should include "333333333333"
  End

  # .gcs-sha belongs to the marketplace, not to the payload installed from it,
  # so on a marketplace whose whole tree is the plugin it sits on one side of
  # the comparison only. Left in, it reports a current payload as stale nightly.
  It "does not count a marketplace's own .gcs-sha as payload drift"
    materialize_marketplace first "$recorded_sha"
    root_source alpha first "$plugins/cache/first/alpha/1.0.0"
    When call run_audit
    The status should be success
    The output should include "6 checks current"
  End

  # A marker that is not a commit says nothing about the tree, so it belongs
  # with the unverifiable results rather than being reported as drift.
  It "reports a GCS marketplace with an unusable .gcs-sha as unverified"
    materialize_marketplace first "not-a-commit"
    When call run_audit
    The status should be success
    The output should include "marketplace/first"
    The output should include "no readable source commit"
  End

  # A comparison that could not be made is a flaky network far more often than
  # a real change, so failing on one would file a to-do the next run clears.
  It "reports a marketplace carrying neither marker as unverified without failing"
    rm -rf "$plugins/marketplaces/first/.git"
    When call run_audit
    The status should be success
    The output should include "marketplace/first"
    The output should include "unverified"
    The output should include "neither a git clone"
  End

  # A stale clone matches every stale payload under it, so calling those current
  # is how one unchecked marketplace hides every install it serves.
  It "does not call a payload current against a marketplace it cannot vouch for"
    rm -rf "$plugins/marketplaces/first/.git"
    When call run_audit
    The status should be success
    The output should include "alpha@first"
    The output should include "itself unverified"
  End

  # An inventory that could not be read is not an empty one. Reporting
  # everything current over it is the silence this tool exists to break.
  It "refuses to report on an inventory it could not read"
    printf 'not json\n' >"$HOME/.claude/settings.json"
    When call run_audit
    The status should equal 2
    The stderr should include "could not enumerate"
    The output should not include "current"
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

  It "does not call a plugin orphaned while its marketplace still lists it"
    drop_source alpha first
    When call run_audit
    The status should be success
    The output should include "alpha@first"
    The output should include "unverified"
    The output should not include "orphaned"
  End

  # A file the audit cannot read is not a file that changed. Reporting it as
  # drift files a to-do that no plugin update can ever clear.
  It "reports an unreadable payload as unverified rather than stale"
    Skip if "root reads a file whatever its mode says" [ "$(id -u)" = 0 ]
    chmod 000 "$plugins/cache/third/beta/abc123/README.md"
    When call run_audit
    The status should be success
    The output should include "beta@third"
    The output should include "could not compare"
  End

  # macOS diff exits 0 here, having written only to stderr, so a payload with a
  # path nothing could compare would otherwise be reported as current.
  It "reports a payload it could not fully read as unverified"
    ln -sf nowhere "$plugins/cache/third/beta/abc123/README.md"
    When call run_audit
    The status should be success
    The output should include "beta@third"
    The output should include "could not compare"
  End
End

# Vibe Island rewrites ~/.claude/settings.json through the dotfiles symlink,
# swapping every hook for the command it runs on a remote agent host. The
# binary it names is not installed here, so hooks fail in every new session,
# and the dirty tracked file stalls the sync until someone looks at it. These
# lock the self-heal: the rewrite is discarded and reported, and nothing else
# is.
Describe "revert_vibe_island_hook_rewrite"
  # This block wants a real git repo, so its stubs deliberately leave out the
  # audit's canned git.
  revert_setup() {
    revert_sandbox="$SHELLSPEC_TMPBASE/claude-upgrade-revert"
    revert_stub="$revert_sandbox/stub"
    repo="$revert_sandbox/repo"
    rm -rf "$revert_sandbox"
    mkdir -p "$revert_stub" "$repo/user"

    export NOTIFY_LOG="$revert_sandbox/notify.log"
    : >"$NOTIFY_LOG"

    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"$NOTIFY_LOG"\n' \
      >"$revert_stub/osascript"
    chmod +x "$revert_stub/osascript"

    printf '#!/usr/bin/env bash\n[ "$1" = log ] && printf "%%s\\n" "${@: -1}" >&2\nexit 0\n' \
      >"$revert_stub/gum"
    chmod +x "$revert_stub/gum"

    write_settings_json "$(guarded_hooks)"
    git -C "$repo" init -q -b main
    git -C "$repo" config user.email spec@example.test
    git -C "$repo" config user.name Spec
    git -C "$repo" config commit.gpgsign false
    git -C "$repo" add -A
    git -C "$repo" commit -q -m "settings"
  }
  BeforeEach 'revert_setup'

  # What the tracked config holds: a bridge invocation guarded on the binary
  # existing, so a machine without it runs a no-op rather than failing.
  guarded_hooks() {
    printf '%s' '"/bin/sh -c [ -x \"$HOME/.vibe-island/bin/vibe-island-bridge\" ] && exit 0"'
  }

  # What the app writes: the remote agent binary, plus the host it means to
  # reach, unguarded.
  rewritten_hooks() {
    printf '%s' '"~/.vibe-island/bin/vibe-island-hook --host user@example"'
  }

  write_settings_json() {
    local command="$1" extra="${2:-bar}"
    jq -n --argjson command "$command" --arg extra "$extra" '{
      env: {EXAMPLE: $extra},
      hooks: {SessionStart: [{hooks: [{type: "command", command: $command}]}]}
    }' >"$repo/user/settings.json"
  }

  call_revert() {
    PATH="$revert_stub:$PATH" zsh -fc \
      'cd "$1" || exit 1; source "$2"; revert_vibe_island_hook_rewrite' _ "$repo" "$upgrade"
  }

  settings_status() {
    if [ -n "$(git -C "$repo" status --porcelain user/settings.json)" ]; then
      printf 'dirty'
    else
      printf 'clean'
    fi
  }

  It "discards the rewrite and says so"
    write_settings_json "$(rewritten_hooks)"
    When call call_revert
    The status should be success
    The stderr should include "Reverting Vibe Island's hook rewrite"
    The contents of file "$NOTIFY_LOG" should include "hook rewrite"
    The result of function settings_status should equal "clean"
  End

  # The app reformats the whole file while it rewrites the hooks, so the
  # revert cannot depend on the rest of the file being byte-identical.
  It "discards a rewrite that also reordered the file"
    write_settings_json "$(rewritten_hooks)"
    jq -S . "$repo/user/settings.json" >"$repo/user/settings.json.next"
    mv "$repo/user/settings.json.next" "$repo/user/settings.json"
    When call call_revert
    The status should be success
    The stderr should include "Reverting"
    The result of function settings_status should equal "clean"
  End

  # Anything outside .hooks could be a real edit. git_review_dirty asks about
  # those, and it cannot ask about a file this already threw away.
  It "leaves a change outside .hooks alone"
    write_settings_json "$(guarded_hooks)" changed
    When call call_revert
    The status should be success
    The stderr should equal ""
    The result of function settings_status should equal "dirty"
  End

  It "leaves a rewrite carrying a change outside .hooks alone"
    write_settings_json "$(rewritten_hooks)" changed
    When call call_revert
    The status should be success
    The stderr should equal ""
    The contents of file "$NOTIFY_LOG" should equal ""
    The result of function settings_status should equal "dirty"
  End

  # Only the app's own command is the app's doing. A hook edited by hand is a
  # local change like any other.
  It "leaves a hand-edited hook alone"
    write_settings_json '"echo hello"'
    When call call_revert
    The status should be success
    The stderr should equal ""
    The result of function settings_status should equal "dirty"
  End

  It "does nothing to a clean tree"
    When call call_revert
    The status should be success
    The stderr should equal ""
    The contents of file "$NOTIFY_LOG" should equal ""
    The result of function settings_status should equal "clean"
  End
End
