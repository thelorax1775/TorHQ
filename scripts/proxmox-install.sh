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
# By default it shows an interactive menu (like the community-scripts installers)
# where you can accept sensible defaults or switch to Advanced and choose the
# container ID, resources, storage location, network, and more. Set every value
# via environment variables (and TORHQ_NONINTERACTIVE=1) to run it unattended.
# Self-contained — no third-party helper framework.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- pretty output --------------------------------------------------------
if [[ -t 1 ]]; then
  RD=$'\033[31m'; GN=$'\033[32m'; YW=$'\033[33m'; BL=$'\033[36m'; NC=$'\033[0m'
else
  RD=""; GN=""; YW=""; BL=""; NC=""
fi
info()   { echo "${BL}==>${NC} $*"; }
ok()     { echo "${GN} ok${NC} $*"; }
warn()   { echo "${YW}warn${NC} $*"; }
die()    { echo "${RD}error${NC} $*" >&2; exit 1; }
cancel() { echo "${RD}Installation cancelled.${NC}" >&2; exit 1; }

# ---- defaults (override via env) ------------------------------------------
REPO_URL="${TORHQ_REPO_URL:-https://github.com/thelorax1775/TorHQ}"
BRANCH="${TORHQ_BRANCH:-main}"
GIT_TOKEN="${TORHQ_GIT_TOKEN:-}"   # required only if the repo is private
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
TEMPLATE_STORAGE="${TORHQ_TEMPLATE_STORAGE:-}"  # auto-detected if empty
CTID="${TORHQ_CTID:-}"             # auto-picked if empty
STORAGE="${TORHQ_STORAGE:-}"       # rootfs storage; auto-detected if empty

# ---- preflight ------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root on the Proxmox VE host."
command -v pct   >/dev/null || die "'pct' not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null || die "'pveam' not found — this must run on a Proxmox VE host."
command -v pvesm >/dev/null || die "'pvesm' not found — this must run on a Proxmox VE host."

# List the names of *enabled* storages that support a given content type.
# pvesm columns: Name Type Status Total Used Available %
enabled_storages() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 && $3=="active"{print $1}'; }
first_enabled()   { enabled_storages "$1" | head -1; }
storage_enabled() { enabled_storages "$1" | grep -qx "$2"; }

# ---- resolve container id + default storages ------------------------------
if [[ -z "$CTID" ]]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null)" || die "could not determine a free container ID."
fi

# Prefer local-lvm for the rootfs when it's enabled; otherwise first enabled rootdir.
if [[ -z "$STORAGE" ]]; then
  if storage_enabled rootdir local-lvm; then STORAGE="local-lvm"; else STORAGE="$(first_enabled rootdir)"; fi
fi
# Templates need a file-level storage (dir/nfs/cifs) with 'vztmpl' content.
[[ -z "$TEMPLATE_STORAGE" ]] && TEMPLATE_STORAGE="$(first_enabled vztmpl)"

# ---- interactive menu (whiptail) ------------------------------------------
INTERACTIVE=1
{ [[ -t 0 ]] && command -v whiptail >/dev/null && [[ -z "${TORHQ_NONINTERACTIVE:-}" ]]; } || INTERACTIVE=0

ask()  { local o; o=$(whiptail --title "TorHQ setup" --inputbox "$1" 10 72 "$2" 3>&1 1>&2 2>&3) || cancel; printf '%s' "$o"; }
numv() { [[ "$1" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf '%s' "$2"; }

# Present a menu of enabled storages for a content type; echoes the choice.
pick_storage() { # $1 content  $2 title  $3 current-default
  local ctype="$1" title="$2" cur="$3"; local -a opts=(); local n t rest
  while read -r n t rest; do opts+=("$n" "type: $t"); done < <(pvesm status -content "$ctype" 2>/dev/null | awk 'NR>1 && $3=="active"')
  [[ ${#opts[@]} -gt 0 ]] || { whiptail --title "$title" --msgbox \
      "No enabled storage supports this content type ($ctype).\n\nEnable one in Datacenter → Storage (add the matching content type), then re-run." 12 72; cancel; }
  local def="${cur:-${opts[0]}}"
  whiptail --title "$title" --default-item "$def" --menu "Select storage" 20 72 10 "${opts[@]}" 3>&1 1>&2 2>&3 || cancel
}

if [[ "$INTERACTIVE" -eq 1 ]]; then
  if whiptail --title "TorHQ installer" --yesno \
      "Create an LXC and install TorHQ with these defaults?\n\n  CTID:      ${CTID}\n  Hostname:  ${HOSTNAME_}\n  Resources: ${CORES} vCPU, ${RAM_MB} MB RAM, ${DISK_GB} GB disk\n  Storage:   ${STORAGE:-<none found>} (rootfs)\n  Template:  ${TEMPLATE_STORAGE:-<none found>}\n  Network:   DHCP on ${BRIDGE}\n\nYes = use defaults.   No = Advanced (choose storage, resources, IP, …)." \
      20 74 --yes-button "Use defaults" --no-button "Advanced"; then
    :
  else
    HOSTNAME_="$(ask "Hostname" "$HOSTNAME_")"
    CTID="$(numv "$(ask "Container ID (CTID)" "$CTID")" "$CTID")"
    UNPRIVILEGED="$(whiptail --title "TorHQ setup" --default-item "$UNPRIVILEGED" --menu "Container type" 11 60 2 \
        1 "Unprivileged (recommended)" 0 "Privileged" 3>&1 1>&2 2>&3)" || cancel
    CORES="$(numv "$(ask "CPU cores" "$CORES")" "$CORES")"
    RAM_MB="$(numv "$(ask "RAM (MB)" "$RAM_MB")" "$RAM_MB")"
    SWAP_MB="$(numv "$(ask "Swap (MB)" "$SWAP_MB")" "$SWAP_MB")"
    DISK_GB="$(numv "$(ask "Root disk size (GB)" "$DISK_GB")" "$DISK_GB")"
    STORAGE="$(pick_storage rootdir "Root filesystem storage" "$STORAGE")"
    TEMPLATE_STORAGE="$(pick_storage vztmpl "Template storage (where the Debian template is downloaded)" "$TEMPLATE_STORAGE")"
    BRIDGE="$(ask "Network bridge" "$BRIDGE")"
    NETMODE="$(whiptail --title "TorHQ setup" --menu "IP assignment" 11 60 2 \
        dhcp "Automatic (DHCP)" static "Manual (static IP)" 3>&1 1>&2 2>&3)" || cancel
    if [[ "$NETMODE" == "static" ]]; then
      NET="$(ask "Static address in CIDR (e.g. 192.168.1.50/24)" "")"
      GATEWAY="$(ask "Gateway (e.g. 192.168.1.1)" "")"
    else
      NET="dhcp"
    fi
    BIND="$(ask "Address TorHQ binds to inside the container" "$BIND")"
    BRANCH="$(ask "Git branch to install from" "$BRANCH")"
  fi
fi

# ---- validate resolved settings -------------------------------------------
pct status "$CTID" &>/dev/null && die "container $CTID already exists — pick a free id."
[[ -n "$STORAGE" ]]          || die "no enabled 'rootdir' storage found — set TORHQ_STORAGE."
[[ -n "$TEMPLATE_STORAGE" ]] || die "no enabled 'vztmpl' (template) storage found — enable one or set TORHQ_TEMPLATE_STORAGE."
storage_enabled vztmpl "$TEMPLATE_STORAGE" || die "template storage '$TEMPLATE_STORAGE' is not enabled for container templates."
if [[ "$NET" != "dhcp" ]]; then
  [[ -n "$GATEWAY" ]] || die "a static network ($NET) requires a gateway (TORHQ_GW)."
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
  template storage : ${TEMPLATE_STORAGE}
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
if [[ -n "${GIT_TOKEN}" ]]; then
  # Private repo: authenticate the clone with a short-lived header so the token
  # is never written to git config (and thus never copied into the app dir).
  AUTH_B64="\$(printf 'x-access-token:%s' "${GIT_TOKEN}" | base64 | tr -d '\n')"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \${AUTH_B64}" \
    git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" /opt/torhq-src
else
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" /opt/torhq-src
fi
cd /opt/torhq-src
# Invoke via bash so it runs even if the file's executable bit didn't survive.
bash ./scripts/install.sh
# Make TorHQ reachable on the container IP (installer defaults to loopback).
sed -i "s#^TORHQ_HOST=.*#TORHQ_HOST=${BIND}#" /etc/torhq/torhq.env
systemctl restart torhq
PROV

info "Installing TorHQ inside the container (Node build can take a few minutes)"
pct push "$CTID" "$PROVISION" /root/torhq-provision.sh --perms 0755 >/dev/null
pct exec "$CTID" -- bash /root/torhq-provision.sh
pct exec "$CTID" -- rm -f /root/torhq-provision.sh || true

# ---- optional: mount a NAS share now --------------------------------------
# Reuse the just-cloned mount-share.sh (works for private repos too — no refetch).
# Runs interactively if there's a TTY, or unattended when TORHQ_SHARE_REMOTE is set.
DO_MOUNT=0
if [[ "$INTERACTIVE" -eq 1 ]]; then
  whiptail --title "TorHQ installer" --yesno \
    "Set up an NFS/SMB share now (for storing downloads)?\n\nYou can always do this later with scripts/mount-share.sh." \
    11 70 && DO_MOUNT=1 || DO_MOUNT=0
elif [[ -n "${TORHQ_SHARE_REMOTE:-}" ]]; then
  DO_MOUNT=1
fi
if [[ "$DO_MOUNT" -eq 1 ]]; then
  info "Setting up a network share"
  MSH="$(mktemp)"
  if pct pull "$CTID" /opt/torhq-src/scripts/mount-share.sh "$MSH" >/dev/null 2>&1; then
    # Default the bind target to this new container unless another CTID was given.
    TORHQ_TARGET_CTID="${TORHQ_TARGET_CTID:-$CTID}" bash "$MSH" \
      || warn "share setup did not complete — re-run scripts/mount-share.sh on the host later."
  else
    warn "could not extract mount-share.sh from the container; set up the share later."
  fi
  rm -f "$MSH"
fi

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
