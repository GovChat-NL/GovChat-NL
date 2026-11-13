#!/usr/bin/env sh
# Wipe the Beleidskompas templates, versions and documents and load the demo seed data again.
# The cases of the users are left alone.
#
# Runs replenish.sql and seed.sql (services/admin-overlay/admin/db/)
# in one transaction inside the beleidskompas-postgres container, so a failure keeps the old data.
# The tables come from the migrations the admin applies at startup, so start the admin once first.
# Then restarts the admin so it republishes the live Beleidskompas config.
#
# Usage:
#   scripts/replenish-beleidskompas-db.sh          # asks for confirmation
#   scripts/replenish-beleidskompas-db.sh --yes    # no prompt (for scripts)
set -eu

cd "$(dirname "$0")/.."

SQL_DIR=services/admin-overlay/admin/db
COMPOSE="docker compose --profile admin-overlay"

if [ "${1:-}" != "--yes" ]; then
  printf "This DELETES all Beleidskompas templates, versions and documents. Type 'yes' to continue: "
  read -r answer
  [ "$answer" = yes ] || { echo "Aborted."; exit 1; }
fi

$COMPOSE up -d --wait beleidskompas-postgres

# POSTGRES_USER / POSTGRES_DB are read inside the container, so no .env parsing is needed here.
cat "$SQL_DIR/replenish.sql" "$SQL_DIR/seed.sql" |
  $COMPOSE exec -T beleidskompas-postgres sh -c \
    'psql --single-transaction -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

$COMPOSE restart govchat-overlay-admin ||
  echo "Admin is not running; it publishes the live config on its next start."

echo "Done. Beleidskompas templates reset to the default seed data."
