#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-agent-detection"
  script="$SHELLSPEC_PROJECT_ROOT/../bin/herdr-agent-detection"

  setup() {
    root=$(mktemp -d)
    export XDG_STATE_HOME="$root/state"
    export XDG_CONFIG_HOME="$root/config"
    base="$XDG_STATE_HOME/herdr/agent-detection/remote/claude.toml"
    override_dir="$XDG_CONFIG_HOME/herdr/agent-detection"
    installed="$override_dir/claude.toml"
    mkdir -p "${base%/*}" "$override_dir" "$root/stub" "$root/empty"

    # `sync` reloads herdr after it writes, and gives up on a machine with no
    # herdr at all. Neither belongs in a test of what it writes.
    #
    # `open`, `gum`, and `osascript` are here for a different reason. A drifting
    # run files a Things to-do, and on the Mac this suite also runs on that is a
    # real to-do in the real Things. The drift path is one edited fixture away at
    # all times, so the stubs are not optional.
    for cmd in herdr open gum osascript; do
      printf '#!/bin/sh\nexit 0\n' >"$root/stub/$cmd"
      chmod +x "$root/stub/$cmd"
    done
  }

  cleanup() {
    rm -rf "$root"
  }

  BeforeEach 'setup'
  AfterEach 'cleanup'

  # The script is zsh, so ~/.zshenv runs and brew shellenv in it can put the
  # real herdr back ahead of the stub. An empty ZDOTDIR leaves $PATH alone.
  run_script() {
    PATH="$root/stub:$PATH" ZDOTDIR="$root/empty" "$script" "$@"
  }

  # Stands in for herdr's own manifest, carrying the working rules the shipped
  # overlay records and the idle rule it outranks.
  write_base() {
    cat >"$base" <<'TOML'
id = "claude"
version = "2026.01.01.1"
min_engine_version = 2

[[rules]]
id = "osc_title_working"
state = "working"
priority = 1100
region = "osc_title"

[[rules]]
id = "btw_overlay_working"
state = "working"
priority = 975
region = "bottom_non_empty_lines(5)"

[[rules]]
id = "live_prompt_box"
state = "idle"
priority = 950
region = "prompt_box_body"
TOML
  }

  It "installs the cached manifest with the overlay appended"
    composed() {
      write_base
      run_script sync >/dev/null || return
      cat "$installed"
    }
    When call composed
    The status should be success
    The output should include 'id = "live_prompt_box"'
    The output should include 'id = "local_spinner_line_working"'
  End

  It "installs nothing when herdr has cached no manifest"
    without_base() {
      run_script sync 2>/dev/null || return
      test ! -e "$installed"
    }
    When call without_base
    The status should be success
  End

  # The other direction of the same situation: something is installed, so herdr
  # is serving a composed manifest, and the cache it was composed from is gone.
  # Silence here would leave that file frozen for good.
  It "fails when a cache it already composed from has gone missing"
    lost_base() {
      write_base
      run_script sync >/dev/null || return
      rm -f "$base"
      run_script sync 2>&1
    }
    When call lost_base
    The status should be failure
    The output should include "can no longer be recomposed"
  End

  # Answers as herdr's own manifest status would. The default stub prints
  # nothing, which stands in for a server that is not running, and the script
  # has to treat that as no answer rather than a bad one.
  stub_herdr_serving() {
    cat >"$root/stub/herdr" <<SH
#!/bin/sh
if [ "\$1" = "server" ] && [ "\$2" = "agent-manifests" ]; then
  printf '{"result":{"manifests":[{"agent":"claude","source":"%s"}]}}\n' "$1"
fi
exit 0
SH
    chmod +x "$root/stub/herdr"
  }

  # Installing to a path herdr no longer reads composes, validates, and writes
  # without complaint. Only herdr can say whether the file landed anywhere.
  It "fails when herdr reports it is reading a different manifest"
    not_served() {
      write_base
      run_script sync >/dev/null || return
      stub_herdr_serving /somewhere/else.toml
      run_script sync 2>&1
    }
    When call not_served
    The status should be failure
    The output should include "herdr is reading /somewhere/else.toml"
  End

  It "passes when herdr reports it is reading what was installed"
    served() {
      write_base
      run_script sync >/dev/null || return
      stub_herdr_serving "$installed"
      run_script sync 2>&1
    }
    When call served
    The status should be success
  End

  It "reports an install left behind by a newer manifest"
    stale() {
      write_base
      run_script sync >/dev/null
      sed 's/2026.01.01.1/2026.02.02.1/' "$base" >"$base.new" && mv "$base.new" "$base"
      run_script check
    }
    When call stale
    The status should be failure
    The output should include "is behind manifest 2026.02.02.1"
  End

  It "reports a manifest that changed which of its rules score working"
    drifted() {
      write_base
      run_script sync >/dev/null
      cat >>"$base" <<'TOML'

[[rules]]
id = "screen_spinner_working"
state = "working"
priority = 960
region = "bottom_non_empty_lines(10)"
TOML
      run_script check
    }
    When call drifted
    The status should be failure
    The output should include "scores working from"
    The output should include "screen_spinner_working"
  End

  It "takes back a file it generated once its overlay is gone"
    orphan() {
      write_base
      printf '%s\n' "# Generated by bin/herdr-agent-detection: codex" \
        >"$override_dir/codex.toml"
      run_script sync >/dev/null || return
      test ! -e "$override_dir/codex.toml"
    }
    When call orphan
    The status should be success
  End

  It "leaves an override it did not generate alone"
    hand_written() {
      write_base
      printf '%s\n' 'id = "codex"' >"$override_dir/codex.toml"
      run_script sync >/dev/null || return
      test -e "$override_dir/codex.toml"
    }
    When call hand_written
    The status should be success
  End

  It "refuses to overwrite a claude override it did not generate"
    protects_hand_written() {
      write_base
      printf '%s\n' 'id = "claude"' >"$installed"
      run_script sync >/dev/null 2>&1
      cat "$installed"
    }
    When call protects_hand_written
    The status should be success
    The output should equal 'id = "claude"'
  End

  # The rules the whole overlay exists for, scored by herdr rather than by a
  # copy of its matching semantics.
  #
  # An earlier version of this suite ran the patterns through `rg` instead. It
  # passed against a rule that matched nothing at all: the two shapes had been
  # written as two entries of one `line_regex`, and herdr ANDs the matchers
  # within a rule, so it demanded a screen holding both lines at once. Only
  # herdr can say what herdr does with a manifest.
  #
  # The screens themselves live in herdr/agent-detection/screens, each recording
  # the state it should score, so `verify` is the whole assertion and its output
  # names any screen that disagrees.
  herdr_bin=$(command -v herdr 2>/dev/null || true)
  cached_manifest="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/agent-detection/remote/claude.toml"

  # Composing needs the manifest herdr fetched, which only exists once herdr has
  # run on this machine. On a CI box that has never started it there is nothing
  # to compose onto and nothing to score.
  no_herdr_to_score_with() {
    [ -z "$herdr_bin" ] || [ ! -s "$cached_manifest" ]
  }

  # The real herdr rather than the stub, since scoring is what is under test.
  # `setup` has already pointed XDG_STATE_HOME at a temp directory, so this
  # scores against a copy of the cached manifest and leaves the machine's alone.
  run_against_cached() {
    cp "$cached_manifest" "$base"
    ZDOTDIR="$root/empty" "$script" "$@" 2>&1
  }

  It "scores every screen the way the screen records"
    When call run_against_cached verify
    The status should be success
    The output should equal ""
    Skip if "herdr has no cached manifest to compose from" no_herdr_to_score_with
  End

  # Ablation is only worth reading if the manifest under test actually loaded.
  # herdr falls back to the one it fetched when it cannot parse an override, and
  # taking a rule out is exactly the edit that produces unparseable TOML, so a
  # broken harness reports every rule as moving nothing and reads as a clean
  # bill of health. A screen that moves when the overlay comes out is proof the
  # overlay was in.
  It "reports which screens each overlay rule is holding up"
    When call run_against_cached ablate
    The status should be success
    The output should include "without local_spinner_line_working"
    The output should include "without local_background_agent_working"
    The output should include "without the overlay"
    The output should include "streaming-turn: working"
    Skip if "herdr has no cached manifest to compose from" no_herdr_to_score_with
  End
End
