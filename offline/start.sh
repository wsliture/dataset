#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./compose.sh up -d --no-build --pull never --wait --wait-timeout 240
