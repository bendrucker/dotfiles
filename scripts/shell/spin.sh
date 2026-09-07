# shellcheck shell=dash
# Sourceable progress spinner that degrades when nothing is watching.
# POSIX sh, so bin/dotf can source it too.
#
# spin <gum spin flags>… -- <command>…
#   Run a command behind a gum spinner when stderr is a terminal, and plainly,
#   under a log line naming the step, when it is not. Returns the command's
#   status either way.
#
#   gum 2 renders through Bubble Tea v2, which writes its frames to stderr
#   whether or not a terminal can interpret them. The unattended jobs run
#   under `2>&1 | tee`, so those frames land in the log as raw control
#   characters and ride into the Things to-do filed from it. A spinner nobody
#   is watching has nothing to offer in exchange.

spin_has_terminal() {
  [ -t 2 ]
}

# bin/dotf runs before scripts/install has installed gum, so this is a real
# state and not just a broken machine.
spin_have_gum() {
  command -v gum >/dev/null 2>&1
}

spin() {
  # gum takes the argument list as given. Only the plain path has to split it,
  # so the split happens after the branch and can consume the arguments.
  if spin_have_gum && spin_has_terminal; then
    gum spin "$@"
    return
  fi

  local title=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      --title) title="$2"; shift 2 ;;
      --title=*) title="${1#--title=}"; shift ;;
      *) shift ;;
    esac
  done

  # Running an empty argument list would report a step that never ran as a
  # success, which is the one outcome a sync must never produce. gum rejects
  # the same call on the branch above.
  if [ "$#" -eq 0 ]; then
    echo "spin: no command to run" >&2
    return 2
  fi

  if [ -n "$title" ] && spin_have_gum; then
    gum log --level info "$title"
  fi

  # The command's own output is the progress report here, so it passes through
  # whatever --show-error would have withheld on a terminal.
  "$@"
}
