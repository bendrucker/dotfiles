# shellcheck shell=bash
# Sourceable helpers for safely fast-forwarding a clone from origin.
# Requires spin.sh (spin) to be sourced first.
#
# git_default_branch [repo_dir]
#   Echo the remote default branch, resolving origin/HEAD with a
#   set-head retry and falling back to "main".
#
# git_https_remote <repo_dir> [remote]
#   Point a github.com SSH remote at its anonymous HTTPS equivalent for fetch,
#   keeping the SSH URL as the pushurl. SSH needs a key from the agent, and
#   Secretive refuses to sign while the Mac is locked, so a 3am launchd fetch
#   dies on "agent refused operation". The synced repos are public, so HTTPS
#   reads need no credentials, while pushes stay on the transport that already
#   has them. Other hosts and URL forms are left alone.
#
# git_https_pin <repo_dir> <remote> <https_url>
#   Hold the remote on HTTPS when an insteadOf rule would send it back to SSH.
#   Only SSH, since a rule routing it to another HTTPS host is a mirror or a
#   proxy to leave in place. Called by git_https_remote. The comment above the
#   function covers why storing an HTTPS URL is not by itself enough.
#
# git_https_env
#   Export the same rewrite as an insteadOf rule, for child processes cloning
#   github.com remotes this repo does not own. Appends to any GIT_CONFIG_COUNT
#   already in the environment rather than replacing it, so a machine-local
#   entry survives. The rule outranks a pushurl, so scope it to the commands
#   that need it rather than exporting it for a whole script.
#
# git_sync <repo_dir> [branch]
#   Guard the target (reject symlinks, non-repos, and dirty working trees),
#   move origin's fetch URL to HTTPS, fetch with retry, and fast-forward only.
#   Returns:
#     0  updated   (new short rev echoed to stdout)
#     2  current   (already up to date)
#     1  failed    (guard, fetch, or pull failure; reason logged)
#   Callers own their own notification and post-update side effects.

GIT_SYNC_UPDATED=0
GIT_SYNC_CURRENT=2
GIT_SYNC_FAILED=1

git_default_branch() {
  local repo_dir="${1:-.}"
  local branch
  branch=$(git -C "$repo_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')

  if [[ -z "$branch" ]]; then
    git -C "$repo_dir" remote set-head origin --auto 2>/dev/null || true
    branch=$(git -C "$repo_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  fi

  echo "${branch:-main}"
}

GIT_HTTPS_SSH_PREFIXES=("git@github.com:" "ssh://git@github.com/")
GIT_HTTPS_BASE="https://github.com/"

# Succeed when a URL is one of the github SSH forms.
git_https_ssh_url() {
  local url="$1" prefix

  for prefix in "${GIT_HTTPS_SSH_PREFIXES[@]}"; do
    [[ "$url" == "$prefix"* ]] && return 0
  done

  return 1
}

# Echo the anonymous HTTPS form of a github.com URL. A URL pointing anywhere
# else echoes nothing, since only github.com is public enough to read without
# credentials.
git_https_url() {
  local url="$1" prefix

  if [[ "$url" == "$GIT_HTTPS_BASE"* ]]; then
    echo "$url"
    return 0
  fi

  for prefix in "${GIT_HTTPS_SSH_PREFIXES[@]}"; do
    if [[ "$url" == "$prefix"* ]]; then
      echo "$GIT_HTTPS_BASE${url#"$prefix"}"
      return 0
    fi
  done
}

git_https_remote() {
  local repo_dir="$1"
  local remote="${2:-origin}"

  # `git remote get-url` resolves insteadOf rules, so it reports HTTPS while
  # .git/config still holds the SSH URL, and the rewrite below never fires.
  local stored
  stored=$(git -C "$repo_dir" config --get "remote.$remote.url" 2>/dev/null) || return 0

  # Only the stored URL decides whether this is a github remote. Asking git what
  # it resolves to would catch a rule pointing some other host at github, but a
  # rule that rewrites the host without keeping the repo path would then have us
  # store a URL naming a repository that does not exist.
  local url
  url=$(git_https_url "$stored")
  [[ -n "$url" ]] || return 0

  if [[ "$stored" != "$url" ]]; then
    gum log --level info "Fetching $remote over HTTPS, pushing over SSH"
    git -C "$repo_dir" config --get "remote.$remote.pushurl" >/dev/null 2>&1 ||
      git -C "$repo_dir" remote set-url --push "$remote" "$stored"
    git -C "$repo_dir" remote set-url "$remote" "$url"
  fi

  git_https_pin "$repo_dir" "$remote" "$url"
}

# Storing an HTTPS URL does not settle which transport the fetch uses. A
# `url.<base>.insteadOf` rule rewrites the URL on its way out of .git/config,
# and one mapping https://github.com/ to git@github.com:, as an org that
# standardizes on SSH would install, puts the fetch straight back on the
# transport the rewrite exists to avoid. Nothing we store escapes it, because
# the rule rewrites whatever is stored.
#
# Git applies the longest matching rule, so one keyed on this remote's full
# HTTPS URL and mapping it to itself outranks any broader github.com rule while
# leaving every other remote alone.
git_https_pin() {
  local repo_dir="$1" remote="$2" url="$3"

  # --get-url resolves insteadOf without contacting the remote, so it reports
  # the URL the fetch will really open.
  local resolved
  resolved=$(git -C "$repo_dir" ls-remote --get-url "$remote")
  [[ "$resolved" == "$url" ]] && return 0

  # SSH is the only transport this pin exists to escape, because it is the one
  # that cannot sign against a locked Mac. A rule sending the remote to another
  # HTTPS host is a mirror or a proxy someone chose, and it can be the only
  # route out. Bypassing it would be worse than the problem being solved, and
  # recording it as the pushurl would aim pushes at a read-only mirror.
  git_https_ssh_url "$resolved" || return 0

  gum log --level info "Pinning $remote to HTTPS past an insteadOf rule"

  # The rule was the only thing holding this remote on SSH. Record where it sent
  # pushes before the pin takes it out of the picture, so a push keeps the
  # transport its credentials are set up for.
  git -C "$repo_dir" config --get "remote.$remote.pushurl" >/dev/null 2>&1 ||
    git -C "$repo_dir" remote set-url --push "$remote" "$resolved"

  # --add, because insteadOf is multi-valued. A plain write refuses a key that
  # already carries more than one rule, and would drop a lone existing one. The
  # guard matters when the pin loses: a rule of equal length registered earlier
  # wins the tie, and an unguarded --add would append another copy every night.
  git -C "$repo_dir" config --get-all "url.$url.insteadOf" 2>/dev/null |
    grep -qxF "$url" ||
    git -C "$repo_dir" config --add "url.$url.insteadOf" "$url"

  resolved=$(git -C "$repo_dir" ls-remote --get-url "$remote")
  [[ "$resolved" == "$url" ]] ||
    gum log --level warn "$remote still resolves to $resolved"
}

git_https_env() {
  local i="${GIT_CONFIG_COUNT:-0}" prefix

  for prefix in "${GIT_HTTPS_SSH_PREFIXES[@]}"; do
    export "GIT_CONFIG_KEY_$i=url.$GIT_HTTPS_BASE.insteadOf"
    export "GIT_CONFIG_VALUE_$i=$prefix"
    i=$((i + 1))
  done

  export GIT_CONFIG_COUNT=$i
}

git_sync_fetch() {
  local repo_dir="$1" branch="$2"
  local retries=4 delay=2 i

  for ((i = 1; i <= retries; i++)); do
    if spin --show-error --title "Fetching origin/$branch (attempt $i/$retries)" -- \
      git -C "$repo_dir" fetch origin "$branch"; then
      return 0
    fi

    if ((i < retries)); then
      gum log --level warn "Fetch failed, retrying in ${delay}s... (attempt $i/$retries)"
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  return 1
}

git_sync() {
  local repo_dir="$1"
  local branch="${2:-}"

  if [[ -L "$repo_dir" ]]; then
    gum log --level error "$repo_dir is a symlink"
    return "$GIT_SYNC_FAILED"
  fi

  if [[ ! -d "$repo_dir/.git" ]]; then
    gum log --level error "$repo_dir is not a git repository"
    return "$GIT_SYNC_FAILED"
  fi

  if ! git -C "$repo_dir" diff --quiet 2>/dev/null ||
     ! git -C "$repo_dir" diff --cached --quiet 2>/dev/null; then
    gum log --level error "$repo_dir has local changes - skipping sync"
    return "$GIT_SYNC_FAILED"
  fi

  git_https_remote "$repo_dir"

  [[ -n "$branch" ]] || branch=$(git_default_branch "$repo_dir")

  if ! git_sync_fetch "$repo_dir" "$branch"; then
    gum log --level error "Failed to fetch after retries"
    return "$GIT_SYNC_FAILED"
  fi

  local local_rev remote_rev
  local_rev=$(git -C "$repo_dir" rev-parse HEAD)
  remote_rev=$(git -C "$repo_dir" rev-parse "origin/$branch")

  if [[ "$local_rev" == "$remote_rev" ]]; then
    gum log --level info "Already up to date (${local_rev:0:7})"
    return "$GIT_SYNC_CURRENT"
  fi

  gum log --level info "Updating from ${local_rev:0:7} to ${remote_rev:0:7}..."

  if ! git -C "$repo_dir" pull --ff-only origin "$branch" 1>&2; then
    gum log --level error "Failed to pull - may need manual intervention"
    return "$GIT_SYNC_FAILED"
  fi

  git -C "$repo_dir" rev-parse --short HEAD
  return "$GIT_SYNC_UPDATED"
}
