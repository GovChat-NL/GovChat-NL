#!/usr/bin/env sh
# Called by make replenish-beleidskompas-db after confirmation.
set -eu
cd "$(dirname "$0")/.."
SQL_DIR=services/admin-overlay/admin/db

cat "$SQL_DIR/replenish.sql" "$SQL_DIR/migrations/0001-init.sql" "$SQL_DIR/seed.sql" |
  docker compose --profile admin-overlay exec -T beleidskompas-postgres sh -c \
    'psql --single-transaction -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
