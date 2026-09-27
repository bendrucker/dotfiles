#!/usr/bin/env bash

# Keep this repo's name-based rules in Backblaze's editable exclusion file. The
# merge lives in TypeScript beside the rules it installs.
exec bun "$(dirname "$0")/backblaze/exclusions.ts"
