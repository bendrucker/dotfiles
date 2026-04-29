#!/usr/bin/env bash
# Rebuild bat's theme cache so the catppuccin .tmTheme files are recognized.
set -euo pipefail

bat cache --build >/dev/null
