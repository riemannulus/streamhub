#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export STREAMHUB_PACKAGE_ROOT="$PACKAGE_ROOT"
exec bun "$PACKAGE_ROOT/app/install.js" uninstall "$@"
