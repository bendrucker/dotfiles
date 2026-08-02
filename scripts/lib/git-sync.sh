# shellcheck shell=bash
# Sourceable helpers for safely fast-forwarding a clone from origin.
#
# git_default_branch [repo_dir]
#   Echo the remote default branch, resolving origin/HEAD with a
#   set-head retry and falling back to "main".
#
# git_https_remote <repo_dir> [remote]
#   Rewrite a github.com SSH remote to its anonymous HTTPS equivalent, in
#   place. SSH needs a key from the agent, and Secretive refuses to sign while
#   the Mac is locked, so a 3am launchd fetch dies on "agent refused
#   operation". The synced repos are public, so HTTPS reads need no
#   credentials at all. Other hosts and URL forms are left alone.
#
# git_https_env
#   Export the same rewrite as an insteadOf rule, for child processes cloning
#   github.com remotes this repo does not own. Appends to any GIT_CONFIG_COUNT
#   already in the environment rather than replacing it, so a machine-local
#   entry survives.
#
# git_sync <repo_dir> [branch]
#   Guard the target (reject symlinks, non-repos, and dirty working trees),
#   move origin to HTTPS, fetch with retry, and fast-forward only.
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

git_https_remote() {
  local repo_dir="$1"
  local remote="${2:-origin}"

  local url
  url=$(git -C "$repo_dir" remote get-url "$remote" 2>/dev/null) || return 0

  local repo_path
  case "$url" in
    git@github.com:*) repo_path="${url#git@github.com:}" ;;
    ssh://git@github.com/*) repo_path="${url#ssh://git@github.com/}" ;;
    *) return 0 ;;
  esac

  gum log --level info "Moving $remote from SSH to HTTPS"
  git -C "$repo_dir" remote set-url "$remote" "https://github.com/$repo_path"
}

git_https_env() {
  local i="${GIT_CONFIG_COUNT:-0}"

  export "GIT_CONFIG_KEY_$i=url.https://github.com/.insteadOf"
  export "GIT_CONFIG_VALUE_$i=git@github.com:"
  export "GIT_CONFIG_KEY_$((i + 1))=url.https://github.com/.insteadOf"
  export "GIT_CONFIG_VALUE_$((i + 1))=ssh://git@github.com/"
  export GIT_CONFIG_COUNT=$((i + 2))
}

git_sync_fetch() {
  local repo_dir="$1" branch="$2"
  local retries=4 delay=2 i

  for ((i = 1; i <= retries; i++)); do
    if gum spin --show-error --title "Fetching origin/$branch (attempt $i/$retries)" -- \
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

  git_https_remote "$repo_dir"

  if ! git -C "$repo_dir" diff --quiet 2>/dev/null ||
     ! git -C "$repo_dir" diff --cached --quiet 2>/dev/null; then
    gum log --level error "$repo_dir has local changes - skipping sync"
    return "$GIT_SYNC_FAILED"
  fi

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
