#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./compose.sh logs -f --tail=200 "$@"
