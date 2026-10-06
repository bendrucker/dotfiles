#!/bin/sh
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$(dirname "$0")/reload.ts"
