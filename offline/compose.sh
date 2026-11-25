#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
compose="$base/bin/docker-compose"
if [ ! -x "$compose" ]; then
  echo "包内 Docker Compose 不可执行，请先运行 sh install.sh。" >&2
  exit 1
fi
exec "$compose" --project-directory "$base" --env-file "$base/.env" -f "$base/docker-compose.offline-arm64.yml" "$@"
