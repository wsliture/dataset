#!/bin/sh
set -eu

lock=$(sha256sum package-lock.json)
stamp=node_modules/.dataset-lock
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock" ]; then
  npm ci
  printf '%s\n' "$lock" > "$stamp"
fi

case "$1" in
  api)
    npm run migrate
    exec ./node_modules/.bin/tsx watch src/server.ts
    ;;
  web)
    exec ./node_modules/.bin/vite --host 0.0.0.0 --strictPort
    ;;
  *) exit 2 ;;
esac
