#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi

APP_DIR="${APP_DIR:-/srv/torhq/app}"
TORHQ_USER="${TORHQ_USER:-torhq}"
SRC="${APP_DIR}/deploy/updater"

install -d -m 0755 -o root -g root /usr/local/lib/torhq
install -m 0644 -o root -g root "${SRC}/update-worker.mjs" /usr/local/lib/torhq/update-worker.mjs
install -m 0755 -o root -g root "${SRC}/torhq-update" /usr/local/sbin/torhq-update
install -m 0644 -o root -g root "${SRC}/torhq-update.service" /etc/systemd/system/torhq-update.service
install -m 0644 -o root -g root "${SRC}/torhq-update.path" /etc/systemd/system/torhq-update.path
install -d -m 0750 -o "${TORHQ_USER}" -g "${TORHQ_USER}" /srv/torhq/data/update

systemctl daemon-reload
systemctl enable --now torhq-update.path >/dev/null
echo "==> Web UI updater installed (torhq-update.path)"
