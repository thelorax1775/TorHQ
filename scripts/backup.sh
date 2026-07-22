#!/usr/bin/env bash
# Back up TorHQ state (SQLite db + env file). Media libraries are NOT included.
set -euo pipefail
DEST="${1:-/srv/torhq/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${DEST}"
# Online, consistent SQLite backup (WAL-safe).
sqlite3 /srv/torhq/data/torhq.db ".backup '${DEST}/torhq-${STAMP}.db'"
cp /etc/torhq/torhq.env "${DEST}/torhq-${STAMP}.env"
tar -czf "${DEST}/torhq-${STAMP}.tar.gz" -C "${DEST}" "torhq-${STAMP}.db" "torhq-${STAMP}.env"
rm -f "${DEST}/torhq-${STAMP}.db" "${DEST}/torhq-${STAMP}.env"
echo "Backup written: ${DEST}/torhq-${STAMP}.tar.gz"
echo "NOTE: the .env holds TORHQ_MASTER_KEY — protect this backup; secrets are unreadable without it."
