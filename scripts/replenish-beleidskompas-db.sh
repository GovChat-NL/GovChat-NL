#!/usr/bin/env sh
# Wipe the Beleidskompas database and load the demo seed data again.
#
# Runs replenish.sql, schema.sql and seed.sql (services/admin-overlay/admin/beleidskompas/)
# in one transaction inside the pgvector container, so a failure keeps the old data.
# Then restarts the admin so it republishes the live Beleidskompas config.
#
# Usage:
#   scripts/replenish-beleidskompas-db.sh          # asks for confirmation
#   scripts/replenish-beleidskompas-db.sh --yes    # no prompt (for scripts)
set -eu

cd "$(dirname "$0")/.."

SQL_DIR=services/admin-overlay/admin/beleidskompas
COMPOSE="docker compose --profile admin-overlay"

if [ "${1:-}" != "--yes" ]; then
  printf "This DELETES all Beleidskompas templates, versions and documents. Type 'yes' to continue: "
  read -r answer
  [ "$answer" = yes ] || { echo "Aborted."; exit 1; }
fi

$COMPOSE up -d --wait pgvector

# POSTGRES_USER / POSTGRES_DB are read inside the container, so no .env parsing is needed here.
cat "$SQL_DIR/replenish.sql" "$SQL_DIR/schema.sql" "$SQL_DIR/seed.sql" |
  $COMPOSE exec -T pgvector sh -c \
    'psql --single-transaction -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

$COMPOSE restart govchat-overlay-admin ||
  echo "Admin is not running; it publishes the live config on its next start."

echo "Done. Beleidskompas database reset to the default seed data."
