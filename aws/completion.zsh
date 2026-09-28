#!/usr/bin/env zsh

# VM names come from the SSH entries vm writes, so completing one never waits
# on AWS.
_vm_names() {
  local -a names
  names=(${XDG_STATE_HOME:-$HOME/.local/state}/vm/*.conf(N:t:r))
  _describe -t names 'vm name' names
}

_vm_kinds() {
  local -a kinds
  local file
  for file in ${commands[vm]:A:h:h}/vm/kinds.toml ${XDG_CONFIG_HOME:-$HOME/.config}/vm/kinds.toml; do
    [[ -r $file ]] && kinds+=(${${(M)${(f)"$(<$file)"}:#\[kinds.*\]}//(\[kinds.|\])/})
  done
  _describe -t kinds 'vm kind' kinds
}

_vm() {
  local -a subcommands
  subcommands=(
    'launch:Start a VM and register it with herdr'
    'connect:Open a shell on a VM'
    'extend:Push out a VM'\''s time limit'
    'pause:Stop a VM, keeping its disk'
    'resume:Start a paused VM with a fresh time limit'
    'list:Show VMs with kind, type, and remaining time'
    'copy:Rsync a local path to a VM'
    'destroy:Terminate a VM and remove its SSH entry and herdr machine'
  )

  _arguments -C '1: :->command' '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'vm command' subcommands
      ;;
    args)
      case ${line[1]} in
        launch)
          _arguments \
            '--kind[Account and launch template]:kind:_vm_kinds' \
            '--name[VM name]:name:' \
            '--type[Instance type]:type:' \
            '--ttl[Time limit]:duration:(30m 1h 2h 4h 8h 12h)'
          ;;
        connect)
          _arguments '1:name:_vm_names' '*::command:_normal'
          ;;
        extend)
          _arguments '1:name:_vm_names' '2:duration:(30m 1h 2h 4h)'
          ;;
        copy)
          _arguments '1:name:_vm_names' '2:source:_files' '3:destination:'
          ;;
        pause|destroy)
          _arguments '1:name:_vm_names'
          ;;
        resume)
          _arguments '1:name:_vm_names' '--ttl[Time limit]:duration:(30m 1h 2h 4h 8h 12h)'
          ;;
        list)
          _arguments '--json[Print JSON]'
          ;;
      esac
      ;;
  esac
}

compdef _vm vm
