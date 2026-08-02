#!/usr/bin/env bash
# shellcheck shell=bash
# Shared fixtures for the scripts specs.

# stub_gum <dir>
#   Write a gum stub into <dir>. `gum spin … -- cmd` runs cmd; `gum log … msg`
#   echoes msg to stderr, where the real gum writes it, so command
#   substitution in callers keeps log lines off the captured stdout.
stub_gum() {
  local dir="$1"

  # printf, not a here-document: bash stages those through a temp file it
  # picks itself, which a sandbox may deny.
  # shellcheck disable=SC2016 # the stub's own $1 and $@, not this shell's
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$1" in' \
    '  spin)' \
    '    shift' \
    '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done' \
    '    [ "$1" = "--" ] && shift' \
    '    exec "$@"' \
    '    ;;' \
    '  log)' \
    '    printf "%s\n" "${@: -1}" >&2' \
    '    ;;' \
    'esac' \
    > "$dir/gum"
  chmod +x "$dir/gum"
}

# stub_osascript <dir>
#   Write a no-op osascript into <dir>, so notify() stays silent and
#   side-effect-free during a test.
stub_osascript() {
  printf '#!/usr/bin/env bash\nexit 0\n' > "$1/osascript"
  chmod +x "$1/osascript"
}
