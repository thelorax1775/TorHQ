#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# TorHQ — Proxmox VE host installer.
#
# Run this ON the Proxmox VE host (as root). It creates a fresh unprivileged
# Debian 12 LXC, then runs TorHQ's in-container installer inside it — so you go
# from nothing to a running TorHQ at http://<container-ip>:8787 in one command.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/proxmox-install.sh)"
#
# Everything is overridable via environment variables (see DEFAULTS below), so
# the same one-liner works unattended. This script is self-contained and does
# not depend on any third-party helper framework.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- pretty output --------------------------------------------------------
if [[ -t 1 ]]; then
  RD=$'\033[31m'; GN=$'\033[32m'; YW=$'\033[33m'; BL=$'\033[36m'; NC=$'\033[0m'
else
  RD=""; GN=""; YW=""; BL=""; NC=""
fi
info() { echo "${BL}==>${NC} $*"; }
ok()   { echo "${GN} ok${NC} $*"; }
warn() { echo "${YW}warn${NC} $*"; }
die()  { echo "${RD}error${NC} $*" >&2; exit 1; }

# ---- defaults (override via env) ------------------------------------------
REPO_URL="${TORHQ_REPO_URL:-https://github.com/thelorax1775/TorHQ}"
BRANCH="${TORHQ_BRANCH:-main}"
HOSTNAME_="${TORHQ_HOSTNAME:-torhq}"
DISK_GB="${TORHQ_DISK:-8}"          # rootfs size in GB
RAM_MB="${TORHQ_RAM:-2048}"
SWAP_MB="${TORHQ_SWAP:-512}"
CORES="${TORHQ_CORES:-2}"
BRIDGE="${TORHQ_BRIDGE:-vmbr0}"
NET="${TORHQ_NET:-dhcp}"            # "dhcp" or a static CIDR like 192.168.1.50/24
GATEWAY="${TORHQ_GW:-}"             # required only for a static NET
UNPRIVILEGED="${TORHQ_UNPRIVILEGED:-1}"
BIND="${TORHQ_BIND:-0.0.0.0}"      # bind address inside the CT (LAN-reachable)
TEMPLATE_STORAGE="${TORHQ_TEMPLATE_STORAGE:-local}"
CTID="${TORHQ_CTID:-}"             # auto-picked if empty
STORAGE="${TORHQ_STORAGE:-}"       # auto-detected if empty

# ---- preflight ------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root on the Proxmox VE host."
command -v pct     >/dev/null || die "'pct' not found — this must run on a Proxmox VE host."
command -v pveam   >/dev/null || die "'pveam' not found — this must run on a Proxmox VE host."
command -v pvesm   >/dev/null || die "'pvesm' not found — this must run on a Proxmox VE host."

# Pick the next free CTID if one wasn't given.
if [[ -z "$CTID" ]]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null)" || die "could not determine a free container ID."
fi
pct status "$CTID" &>/dev/null && die "container $CTID already exists — set TORHQ_CTID to a free id."

# Pick a rootfs storage that can hold containers, if not specified.
if [[ -z "$STORAGE" ]]; then
  if pvesm status -content rootdir 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "local-lvm"; then
    STORAGE="local-lvm"
  else
    STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1{print $1; exit}')"
  fi
  [[ -n "$STORAGE" ]] || die "no storage with 'rootdir' content found — set TORHQ_STORAGE."
fi

# Validate a static network config if requested.
if [[ "$NET" != "dhcp" ]]; then
  [[ -n "$GATEWAY" ]] || die "a static TORHQ_NET ($NET) requires TORHQ_GW (gateway)."
  IPCONF="ip=${NET},gw=${GATEWAY}"
else
  IPCONF="ip=dhcp"
fi

cat <<CFG
${BL}TorHQ Proxmox installer${NC}
  container id     : ${CTID}
  hostname         : ${HOSTNAME_}
  resources        : ${CORES} vCPU, ${RAM_MB} MB RAM, ${SWAP_MB} MB swap, ${DISK_GB} GB disk
  rootfs storage   : ${STORAGE}
  network          : ${BRIDGE} (${IPCONF})
  unprivileged     : ${UNPRIVILEGED}
  source           : ${REPO_URL} @ ${BRANCH}
  bind address     : ${BIND}:8787
CFG

# ---- template -------------------------------------------------------------
info "Ensuring a Debian 12 LXC template is available"
pveam update >/dev/null 2>&1 || warn "pveam update failed; continuing with the local list"
TEMPLATE_NAME="$(pveam available --section system 2>/dev/null \
  | grep -oE 'debian-12-standard_[^ ]+_amd64\.tar\.(zst|gz|xz)' | sort -V | tail -1)"
[[ -n "$TEMPLATE_NAME" ]] || die "no Debian 12 template offered by 'pveam available'."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE_NAME"; then
  info "Downloading $TEMPLATE_NAME to $TEMPLATE_STORAGE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_NAME" >/dev/null || die "template download failed."
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_NAME}"
ok "template: $TEMPLATE_REF"

# ---- create + start -------------------------------------------------------
info "Creating container $CTID"
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$HOSTNAME_" \
  --cores "$CORES" --memory "$RAM_MB" --swap "$SWAP_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},${IPCONF}" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --ostype debian \
  --onboot 1 \
  --tags torhq \
  --description "TorHQ — media homelab control plane. Created by scripts/proxmox-install.sh." \
  >/dev/null || die "pct create failed."
ok "container created"

info "Starting container"
pct start "$CTID" >/dev/null || die "pct start failed."

# Wait for an IPv4 address on eth0 (DHCP or static both need the iface up).
info "Waiting for the container network"
CT_IP=""
for _ in $(seq 1 30); do
  CT_IP="$(pct exec "$CTID" -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)"
  [[ -n "$CT_IP" ]] && break
  sleep 2
done
[[ -n "$CT_IP" ]] || die "the container did not obtain an IPv4 address."
ok "container ip: $CT_IP"

# ---- provision inside the container ---------------------------------------
# Reuse TorHQ's own in-container installer (scripts/install.sh) so there is a
# single source of truth for the app setup.
PROVISION="$(mktemp)"
trap 'rm -f "$PROVISION"' EXIT
cat > "$PROVISION" <<PROV
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl ca-certificates openssl
rm -rf /opt/torhq-src
git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" /opt/torhq-src
cd /opt/torhq-src
./scripts/install.sh
# Make TorHQ reachable on the container IP (installer defaults to loopback).
sed -i "s#^TORHQ_HOST=.*#TORHQ_HOST=${BIND}#" /etc/torhq/torhq.env
systemctl restart torhq
PROV

info "Installing TorHQ inside the container (Node build can take a few minutes)"
pct push "$CTID" "$PROVISION" /root/torhq-provision.sh --perms 0755 >/dev/null
pct exec "$CTID" -- bash /root/torhq-provision.sh
pct exec "$CTID" -- rm -f /root/torhq-provision.sh || true

cat <<DONE

${GN}TorHQ is up.${NC}
  URL      : http://${CT_IP}:8787   (create the admin account on first visit)
  Console  : pct enter ${CTID}
  Logs     : pct exec ${CTID} -- journalctl -u torhq -f
  Master key + secrets live in the container at /etc/torhq/torhq.env — back it up.

Note: TorHQ is bound to ${BIND} for LAN access. To expose it beyond your LAN,
put it behind the nginx TLS reverse proxy (see README) and set TORHQ_TRUST_PROXY
and TORHQ_COOKIE_SECURE.
DONE
