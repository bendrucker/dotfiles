#!/usr/bin/env sh

alias d='docker'
alias dc='docker-compose'

alias dsh="docker run --entrypoint sh -it"

alias docker-gc="docker run --rm --userns host -v /var/run/docker.sock:/var/run/docker.sock -v /etc:/etc spotify/docker-gc"