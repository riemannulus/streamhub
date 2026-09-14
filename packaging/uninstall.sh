#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export STREAMHUB_PACKAGE_ROOT="$PACKAGE_ROOT"
if [ "${1:-}" = "--prefix" ]; then
  STREAMHUB_COMMAND_PATH="${2:-}/bin/streamhub"
else
  APPLICATION_ROOT=$(dirname -- "$(dirname -- "$PACKAGE_ROOT")")
  case "$APPLICATION_ROOT" in
    "$HOME/Library/Application Support/Streamhub") STREAMHUB_COMMAND_PATH="$HOME/.local/bin/streamhub" ;;
    */Application\ Support/Streamhub)
      PREFIX=$(dirname -- "$(dirname -- "$APPLICATION_ROOT")")
      STREAMHUB_COMMAND_PATH="$PREFIX/bin/streamhub"
      ;;
    *) STREAMHUB_COMMAND_PATH="$HOME/.local/bin/streamhub" ;;
  esac
fi
export STREAMHUB_COMMAND_PATH
exec bun "$PACKAGE_ROOT/app/install.js" uninstall "$@"
