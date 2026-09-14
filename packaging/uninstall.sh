#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export STREAMHUB_PACKAGE_ROOT="$PACKAGE_ROOT"
if [ "${1:-}" = "--prefix" ]; then
  APPLICATION_ROOT=$(dirname -- "$(dirname -- "$PACKAGE_ROOT")")
  PREFIX=$(dirname -- "$(dirname -- "$APPLICATION_ROOT")")
  STREAMHUB_COMMAND_PATH="$PREFIX/bin/streamhub"
else
  STREAMHUB_COMMAND_PATH="$HOME/.local/bin/streamhub"
fi
export STREAMHUB_COMMAND_PATH
exec bun "$PACKAGE_ROOT/app/install.js" uninstall "$@"
