#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APPLICATION_ROOT=$(dirname -- "$(dirname -- "$PACKAGE_ROOT")")
PREFIX=$(dirname -- "$(dirname -- "$APPLICATION_ROOT")")
export STREAMHUB_PACKAGE_ROOT="$PACKAGE_ROOT"
STREAMHUB_COMMAND_PATH="$PREFIX/bin/streamhub"
export STREAMHUB_COMMAND_PATH
exec bun "$PACKAGE_ROOT/app/install.js" uninstall "$@"
