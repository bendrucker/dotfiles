#!/usr/bin/env bash

# Keep this repo's name-based rules in Backblaze's editable exclusion file.
exec bun "$(dirname "$0")/backblaze/exclusions.ts"
