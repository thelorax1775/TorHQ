#!/usr/bin/env bash
# Pull new code and rebuild in place, then restart. Run as root.
set -euo pipefail
APP_DIR="/srv/torhq/app"
cd "${APP_DIR}"
/srv/torhq/app/scripts/backup.sh >/dev/null || true
# If deployed from git:
if [[ -d .git ]]; then git pull --ff-only; fi
npm ci --include=dev   # devDependencies (tsc/vite) are needed to build
npm run build
npm run migrate --workspace server || true   # migrations are idempotent
chown -R torhq:torhq /srv/torhq
systemctl restart torhq
echo "Upgrade complete. journalctl -u torhq -f"
