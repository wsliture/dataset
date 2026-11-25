#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$(node -p "'postgres://dataset:' + encodeURIComponent(process.env.POSTGRES_PASSWORD) + '@postgres:5432/dataset'")
  export DATABASE_URL
  unset POSTGRES_PASSWORD
fi
node dist/migrate.js
exec node dist/server.js
