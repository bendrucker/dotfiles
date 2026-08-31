# shellcheck shell=bash
# Sourceable interactive handler for a dirty working tree before a sync.
# Requires report-failure.sh (notify), git-sync.sh (git_default_branch), and
# spin.sh (spin) to be sourced first. gum and gh must be on PATH.
#
# render_diff [repo_dir]
#   Print the diff of tracked changes against HEAD, then every untracked file as
#   a new-file diff. JSON files are normalized with `jq -S` so cosmetic key
#   reordering doesn't show as noise; everything else falls back to plain
#   `git diff HEAD`.
#
# capturable_content [repo_dir]
#   Print everything `git add -A` would capture: the tracked diff against HEAD,
#   plus the name and contents of every untracked file.
#
# host_names
#   Print every name this machine answers to, one per line: the `hostname`
#   forms plus scutil's ComputerName, LocalHostName, and HostName.
#
# changes_name_host [repo_dir]
#   Return 0 when capturable_content contains one of host_names, matched
#   case-insensitively on word boundaries.
#
# git_review_open_pr <repo_dir> <title>
#   Capture the working-tree changes (tracked and untracked) onto a fresh branch,
#   push it, and open a draft PR with `gh`, then return the base branch to a clean
#   state so the caller can fast-forward it. Returns nonzero if any step fails,
#   leaving the base branch checked out. Refuses before touching the tree when
#   what it would capture names this machine, and again once it is staged.
#
# git_review_fetch <repo_dir> <branch>
#   Move origin to HTTPS and refresh origin/<branch>, once. Best effort: git_sync
#   retries properly a moment later, and a failure here only costs the gate the
#   incoming rules.
#
# git_review_blocking <repo_dir> [branch]
#   Print the paths that still block a sync, one per line. Tracked changes always
#   block. Untracked paths are judged against origin/<branch>'s .gitignore when
#   that resolves; with no branch, or no such file, the local rules decide.
#
# git_review_dirty <repo_dir> <title>
#   If nothing blocks, return 0. Otherwise render the diff and, on a TTY, prompt
#   to discard, open a PR, or skip. The prompt draws on /dev/tty so it survives a
#   caller that pipes stderr. Without a TTY (launchd) it skips. Returns 0 to
#   continue syncing (nothing blocking, discard, or PR), 1 to abort (skip).

render_diff() {
  local repo_dir="${1:-.}"
  (
    cd "$repo_dir" || return

    local f head_sorted working_sorted
    local changed_files
    changed_files=$(git diff HEAD --name-only 2>/dev/null)
    if [[ -n "$changed_files" ]]; then
      while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        if [[ "$f" == *.json ]]; then
          head_sorted=$(git show "HEAD:$f" 2>/dev/null | jq -S . 2>/dev/null) &&
            working_sorted=$(jq -S . "$f" 2>/dev/null) &&
            { diff -u --label "a/$f" --label "b/$f" <(echo "$head_sorted") <(echo "$working_sorted") || true; continue; }
        fi
        git diff HEAD -- "$f" 2>/dev/null
      done <<< "$changed_files"
    fi

    # `git diff HEAD` never names an untracked file, while the gate calls one
    # dirty, so a tree dirty only in untracked paths rendered an empty diff -
    # which was all the report of that block had to go on.
    git ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r f; do
      [[ -f "$f" ]] || continue
      git diff --no-index -- /dev/null "$f" 2>/dev/null || true
    done
  )
}

capturable_content() {
  local repo_dir="${1:-.}"
  (
    cd "$repo_dir" || return
    git diff HEAD
    # git add -A stages untracked files too, so they are as publishable as the
    # tracked diff. Their names carry as much as their contents.
    local f
    git ls-files --others --exclude-standard | while IFS= read -r f; do
      printf '%s\n' "$f"
      [[ -f "$f" ]] && cat "$f"
    done
  ) 2>/dev/null
}

# Every name this machine answers to. `hostname` covers the POSIX forms, and
# scutil covers the ones macOS keeps separately: an app asking Cocoa for the
# computer's name gets ComputerName, which a user can set to something the
# POSIX hostname does not contain. Duplicates are harmless, so they are not
# filtered.
host_names() {
  hostname -s 2>/dev/null
  hostname 2>/dev/null

  local key
  for key in ComputerName LocalHostName HostName; do
    scutil --get "$key" 2>/dev/null
  done
}

changes_name_host() {
  local repo_dir="${1:-.}"

  # grep -F reads a newline-separated argument as several patterns, so the whole
  # set goes in one pass without an array or a temp file. Blank lines are
  # dropped first: an empty pattern matches every line and would refuse every
  # sync.
  local names
  names=$(host_names | grep -v '^[[:space:]]*$')
  [[ -z "$names" ]] && return 1

  # -w, so a short machine name does not match inside an unrelated word and
  # refuse a sync over nothing. Word boundaries still catch every form the app
  # writes, including the user@host in its hook command.
  #
  # Streamed into grep rather than captured first: an untracked file can be any
  # size, and grep -q stops reading at the first match.
  capturable_content "$repo_dir" | grep -qiwF -- "$names"
}

git_review_open_pr() {
  local repo_dir="$1" title="$2"

  # The repos this serves are public deploy checkouts, and what lands in them
  # without being written by hand is whatever an app decided to configure -
  # Vibe Island puts the machine's own name into a hook command. Refuse the
  # whole sync, leaving the tree for inspection.
  if changes_name_host "$repo_dir"; then
    gum log --level error "Local changes name this machine - refusing to push them to a public remote"
    notify "$title" "Skipped: local changes name this machine"
    return 1
  fi

  local base branch
  base=$(git -C "$repo_dir" symbolic-ref --short HEAD 2>/dev/null || git_default_branch "$repo_dir")
  branch="sync/local-changes-$(date +%Y%m%d-%H%M%S)"

  gum log --level info "Opening a PR for local changes on $branch..."

  if ! git -C "$repo_dir" checkout -b "$branch"; then
    gum log --level error "Failed to create $branch"
    return 1
  fi

  if ! git -C "$repo_dir" add -A; then
    gum log --level error "Failed to stage local changes"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  # Checked again now that the tree is staged. Vibe Island writes on its own
  # schedule, so a write that landed after the first check would otherwise ride
  # out on this commit.
  if changes_name_host "$repo_dir"; then
    gum log --level error "Local changes name this machine - refusing to push them to a public remote"
    notify "$title" "Skipped: local changes name this machine"
    git -C "$repo_dir" reset >/dev/null 2>&1
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  if ! git -C "$repo_dir" commit -m "sync: local changes captured"; then
    gum log --level error "Failed to commit local changes"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  if ! spin --show-error --title "Pushing $branch" -- \
    git -C "$repo_dir" push -u origin "$branch"; then
    gum log --level error "Failed to push $branch - change is committed locally on $branch"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  local pr_url
  if ! pr_url=$(cd "$repo_dir" && gh pr create --draft --base "$base" --head "$branch" --fill 2>&1); then
    gum log --level error "Failed to create PR: $pr_url"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  if ! git -C "$repo_dir" checkout "$base"; then
    gum log --level error "Failed to return to $base - change is safe on $branch"
    return 1
  fi
  gum log --level info "PR opened: $pr_url"
  notify "$title" "Opened PR for local changes"
}

git_review_fetch() {
  local repo_dir="$1" branch="$2"

  git_https_remote "$repo_dir"
  spin --title "Fetching origin/$branch" -- git -C "$repo_dir" fetch origin "$branch"
}

git_review_blocking() {
  local repo_dir="${1:-.}" branch="${2:-}"

  # .gitignore has no say over a path git already tracks, so a tracked change
  # blocks whatever is arriving.
  git -C "$repo_dir" status --porcelain --untracked-files=no 2>/dev/null | cut -c4-

  # The incoming rules have to reach ls-files as a real file. Handed a process
  # substitution, git sizes the pipe with fstat and reads nothing whenever the
  # writer has yet to run, so the exclusions would apply or not by luck of
  # scheduling. The git dir holds it: writable wherever the pull this gate
  # guards would be, and private to the repo.
  local git_dir="" exclude=""
  [[ -n "$branch" ]] && git_dir=$(git -C "$repo_dir" rev-parse --absolute-git-dir 2>/dev/null)

  if [[ -n "$git_dir" ]]; then
    exclude="$git_dir/incoming-exclude"
    git -C "$repo_dir" show "origin/$branch:.gitignore" >"$exclude" 2>/dev/null ||
      { rm -f "$exclude"; exclude=""; }
  fi

  if [[ -n "$exclude" ]]; then
    git -C "$repo_dir" ls-files --others --exclude-standard --exclude-from="$exclude" 2>/dev/null
    rm -f "$exclude"
  else
    git -C "$repo_dir" ls-files --others --exclude-standard 2>/dev/null
  fi
}

git_review_dirty() {
  local repo_dir="$1" title="$2"

  local tree
  tree=$(git -C "$repo_dir" status --porcelain 2>/dev/null)
  if [[ -z "$tree" ]]; then
    return 0
  fi

  # A .gitignore rule reaches this checkout only through the pull the gate is
  # about to block, so a rule shipped alongside the files it covers deadlocks:
  # the files hold the gate shut and the gate holds the rule out. Fetching needs
  # no clean tree, so it happens first and the incoming rules get to answer for
  # the paths they were written for. A fetch that fails leaves the local rules
  # deciding, as before.
  local branch
  branch=$(git_default_branch "$repo_dir")
  git_review_fetch "$repo_dir" "$branch" || branch=""

  local blocking
  blocking=$(git_review_blocking "$repo_dir" "$branch")
  if [[ -z "$blocking" ]]; then
    gum log --level info "Local changes in $repo_dir are ignored by the incoming .gitignore - syncing"
    return 0
  fi

  gum log --level info "Local changes in $repo_dir:"
  echo "$tree" >&2
  gum log --level info "Diff:"
  render_diff "$repo_dir" >&2

  # The blocking paths get a log line to themselves, ahead of any error.
  # report_upgrade_failure fingerprints on fields 2-4 of the WARN and ERRO lines,
  # and the error below reads identically whatever is dirty, so without this a
  # block that recurs over a different dirty set files nothing after the first
  # and the deadlock goes silent.
  gum log --level warn "$(echo "$blocking" | tr '\n' ' ')"

  if [[ ! -t 0 ]]; then
    gum log --level error "Local changes present - skipping sync"
    notify "$title" "Skipped: local changes present"
    return 1
  fi

  # gum draws its UI on stderr and takes the viewport size from the terminal
  # stderr points at. A caller that pipes stderr, as bin/claude-upgrade does to
  # tee the run into a log, leaves that size at zero and every frame renders
  # empty, while stdin is still the terminal so the keys keep working: an
  # invisible prompt that answers the first Enter with whatever the cursor
  # started on. Draw on the controlling terminal instead. Only the frames move,
  # so the lines above still reach the log. spin.sh answers the same problem by
  # dropping the spinner for a log line, which a prompt has no equivalent of.
  local choice
  choice=$(gum choose --header "Local changes present. What now?" \
    "Discard and sync" "Open a PR and sync" "Skip sync" 2>/dev/tty) || choice="Skip sync"

  case "$choice" in
    "Discard and sync")
      gum log --level info "Discarding local changes..."
      git -C "$repo_dir" reset --hard HEAD
      git -C "$repo_dir" clean -fd
      ;;
    "Open a PR and sync")
      git_review_open_pr "$repo_dir" "$title" || return 1
      ;;
    *)
      gum log --level error "Local changes present - skipping sync"
      notify "$title" "Skipped: local changes present"
      return 1
      ;;
  esac
}
