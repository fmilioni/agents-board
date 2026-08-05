#!/bin/sh

set -eu

target_database="${AB_POSTGRES_DB:-agents_board}"

if [ "$target_database" != "agents_board" ]; then
  exit 0
fi

target_exists="$(psql --dbname postgres --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname = 'agents_board'")"
legacy_exists="$(psql --dbname postgres --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname = 'organizer'")"

if [ "$target_exists" = "1" ] && [ "$legacy_exists" = "1" ]; then
  echo "Both organizer and agents_board databases exist; refusing to choose one automatically." >&2
  exit 1
fi

if [ "$target_exists" = "1" ]; then
  exit 0
fi

if [ "$legacy_exists" != "1" ]; then
  exit 0
fi

psql --dbname postgres --set ON_ERROR_STOP=1 --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'organizer' AND pid <> pg_backend_pid()"
psql --dbname postgres --set ON_ERROR_STOP=1 --command "ALTER DATABASE organizer RENAME TO agents_board"
