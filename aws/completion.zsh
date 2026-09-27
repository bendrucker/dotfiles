#!/usr/bin/env zsh

# VM names come from the SSH entries perf-vm writes, so completing one never
# waits on AWS.
_perf_vm_names() {
  local -a names
  names=(~/.ssh/perf-vm/*.conf(N:t:r))
  _describe -t names 'perf-vm name' names
}

_perf_vm() {
  local -a subcommands
  subcommands=(
    'launch:Start a VM and register it with herdr'
    'connect:Open a shell on a VM'
    'extend:Push out a VM'\''s time limit'
    'pause:Stop a VM, keeping its disk'
    'resume:Start a paused VM with a fresh time limit'
    'list:Show VMs with type and remaining time'
    'destroy:Terminate a VM and remove its SSH entry and herdr machine'
  )

  _arguments -C '1: :->command' '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'perf-vm command' subcommands
      ;;
    args)
      case ${line[1]} in
        launch)
          _arguments \
            '--name[VM name]:name:' \
            '--type[Instance type]:type:(c8g.medium c8g.large c8g.xlarge c8g.2xlarge c8g.4xlarge c8g.8xlarge c8g.16xlarge c8g.metal-24xl m8g.xlarge m8g.4xlarge r8g.xlarge r8g.4xlarge)' \
            '--ttl[Time limit, at most 12h]:duration:(30m 1h 2h 4h 8h 12h)'
          ;;
        connect)
          _arguments '1:name:_perf_vm_names' '*::command:_normal'
          ;;
        extend)
          _arguments '1:name:_perf_vm_names' '2:duration:(30m 1h 2h 4h)'
          ;;
        pause|destroy)
          _arguments '1:name:_perf_vm_names'
          ;;
        resume)
          _arguments '1:name:_perf_vm_names' '--ttl[Time limit, at most 12h]:duration:(30m 1h 2h 4h 8h 12h)'
          ;;
        list)
          _arguments '--json[Print JSON]'
          ;;
      esac
      ;;
  esac
}

compdef _perf_vm perf-vm
