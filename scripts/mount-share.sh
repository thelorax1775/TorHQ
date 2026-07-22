#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# TorHQ — NFS/SMB share mounter for Proxmox VE.
#
# Run this ON the Proxmox VE host (as root). It mounts an NFS or SMB (CIFS)
# share on the host, makes it persistent (fstab), and optionally bind-mounts it
# into an LXC container (e.g. the one running qBittorrent) so downloads land on
# your NAS. This is the correct pattern for unprivileged LXCs, which cannot
# mount network filesystems themselves.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/mount-share.sh)"
#
# Interactive by default; drive it unattended with the TORHQ_* env vars below
# plus TORHQ_NONINTERACTIVE=1. Self-contained — no third-party framework.
# ---------------------------------------------------------------------------
set -euo pipefail

if [[ -t 1 ]]; then
  RD=$'\033[31m'; GN=$'\033[32m'; YW=$'\033[33m'; BL=$'\033[36m'; NC=$'\033[0m'
else RD=""; GN=""; YW=""; BL=""; NC=""; fi
info()   { echo "${BL}==>${NC} $*"; }
ok()     { echo "${GN} ok${NC} $*"; }
warn()   { echo "${YW}warn${NC} $*"; }
die()    { echo "${RD}error${NC} $*" >&2; exit 1; }
cancel() { echo "${RD}Cancelled.${NC}" >&2; exit 1; }

# ---- defaults (override via env) ------------------------------------------
TYPE="${TORHQ_SHARE_TYPE:-}"         # nfs | cifs
REMOTE="${TORHQ_SHARE_REMOTE:-}"     # nfs: server:/export   cifs: //server/share
NAME="${TORHQ_SHARE_NAME:-}"         # short name -> /mnt/torhq-shares/<name>
SMB_USER="${TORHQ_SMB_USER:-}"
SMB_PASS="${TORHQ_SMB_PASS:-}"
SMB_DOMAIN="${TORHQ_SMB_DOMAIN:-}"
EXTRA_OPTS="${TORHQ_SHARE_OPTS:-}"   # appended to the mount options
TARGET_CTID="${TORHQ_TARGET_CTID:-}" # LXC to bind the share into (optional)
CT_PATH="${TORHQ_CT_PATH:-}"         # mountpoint inside that container
HOST_BASE="${TORHQ_HOST_BASE:-/mnt/torhq-shares}"

[[ $EUID -eq 0 ]] || die "run as root on the Proxmox VE host."
command -v mount >/dev/null || die "'mount' not found."

INTERACTIVE=1
{ [[ -t 0 ]] && command -v whiptail >/dev/null && [[ -z "${TORHQ_NONINTERACTIVE:-}" ]]; } || INTERACTIVE=0
ask()  { local o; o=$(whiptail --title "TorHQ mount" --inputbox "$1" 10 74 "$2" 3>&1 1>&2 2>&3) || cancel; printf '%s' "$o"; }
pass() { local o; o=$(whiptail --title "TorHQ mount" --passwordbox "$1" 10 74 3>&1 1>&2 2>&3) || cancel; printf '%s' "$o"; }

if [[ "$INTERACTIVE" -eq 1 ]]; then
  TYPE="${TYPE:-$(whiptail --title "TorHQ mount" --menu "Share type" 11 60 2 \
      nfs "NFS export" cifs "SMB / CIFS (Windows, Samba)" 3>&1 1>&2 2>&3)}" || cancel
  if [[ "$TYPE" == "nfs" ]]; then
    REMOTE="$(ask "NFS export (server:/path)" "${REMOTE:-192.168.1.10:/volume1/media}")"
  else
    REMOTE="$(ask "SMB share (//server/share)" "${REMOTE:-//192.168.1.10/media}")"
    SMB_USER="$(ask "SMB username" "$SMB_USER")"
    SMB_PASS="$(pass "SMB password")"
    SMB_DOMAIN="$(ask "SMB domain/workgroup (optional)" "$SMB_DOMAIN")"
  fi
  NAME="$(ask "Short name for this share (a-z0-9-)" "${NAME:-media}")"
  if whiptail --title "TorHQ mount" --yesno "Bind this share into an LXC container now?\n(e.g. the container running qBittorrent)" 10 66; then
    TARGET_CTID="$(ask "Target container ID (CTID)" "$TARGET_CTID")"
    CT_PATH="$(ask "Mountpoint inside that container" "${CT_PATH:-/mnt/$NAME}")"
  fi
fi

# ---- validate -------------------------------------------------------------
[[ "$TYPE" == "nfs" || "$TYPE" == "cifs" ]] || die "TORHQ_SHARE_TYPE must be 'nfs' or 'cifs'."
[[ -n "$REMOTE" ]] || die "a remote share (TORHQ_SHARE_REMOTE) is required."
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "TORHQ_SHARE_NAME must be lowercase a-z0-9- (got '${NAME:-}')."
if [[ "$TYPE" == "cifs" ]]; then
  [[ -n "$SMB_USER" ]] || die "SMB shares need TORHQ_SMB_USER (and TORHQ_SMB_PASS)."
fi
if [[ -n "$TARGET_CTID" ]]; then
  command -v pct >/dev/null || die "'pct' not found but a target CTID was given (bind needs Proxmox)."
  pct status "$TARGET_CTID" &>/dev/null || die "container $TARGET_CTID does not exist."
  [[ -n "$CT_PATH" ]] || die "TORHQ_CT_PATH (mountpoint inside the container) is required with a target CTID."
  [[ "$CT_PATH" == /* ]] || die "TORHQ_CT_PATH must be an absolute path."
fi

HOST_MP="${HOST_BASE%/}/${NAME}"

# ---- dependencies ---------------------------------------------------------
if [[ "$TYPE" == "nfs" ]] && ! command -v mount.nfs >/dev/null; then
  info "Installing nfs-common"; DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq nfs-common
fi
if [[ "$TYPE" == "cifs" ]] && ! command -v mount.cifs >/dev/null; then
  info "Installing cifs-utils"; DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq cifs-utils
fi

mkdir -p "$HOST_MP"

# ---- build the fstab options ----------------------------------------------
CRED_FILE=""
if [[ "$TYPE" == "nfs" ]]; then
  OPTS="_netdev,noatime,soft,timeo=150,retrans=3"
  SRC="$REMOTE"
else
  # Store SMB credentials root-only, never in fstab in plaintext.
  mkdir -p /etc/torhq-shares; CRED_FILE="/etc/torhq-shares/${NAME}.cred"
  { echo "username=${SMB_USER}"; echo "password=${SMB_PASS}"; [[ -n "$SMB_DOMAIN" ]] && echo "domain=${SMB_DOMAIN}"; } > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  # uid/gid 0 -> maps to the unprivileged container's root (host 100000). Override
  # via TORHQ_SHARE_OPTS (e.g. uid=101000,gid=101000) to match your download user.
  OPTS="_netdev,credentials=${CRED_FILE},iocharset=utf8,vers=3.0,uid=0,gid=0,file_mode=0770,dir_mode=0770"
  SRC="$REMOTE"
fi
[[ -n "$EXTRA_OPTS" ]] && OPTS="${OPTS},${EXTRA_OPTS}"

# ---- persist in fstab (idempotent, marked) + mount now --------------------
MARK="# torhq-share:${NAME}"
info "Writing /etc/fstab entry"
# Drop any prior entry for this share (marker line + the following fstab line).
sed -i "\#${MARK}#,+1d" /etc/fstab 2>/dev/null || true
printf '%s\n%s %s %s %s 0 0\n' "$MARK" "$SRC" "$HOST_MP" "$TYPE" "$OPTS" >> /etc/fstab

info "Mounting $SRC -> $HOST_MP"
mountpoint -q "$HOST_MP" && umount "$HOST_MP" 2>/dev/null || true
if ! mount "$HOST_MP"; then
  warn "mount failed — the fstab entry is in place; fix connectivity/credentials and run: mount $HOST_MP"
  die "could not mount the share (see the error above)."
fi
ok "mounted: $(findmnt -n -o SOURCE,FSTYPE,SIZE,AVAIL --target "$HOST_MP" 2>/dev/null || echo "$SRC")"

# ---- bind into the target container ---------------------------------------
if [[ -n "$TARGET_CTID" ]]; then
  # Pick the next free mpN slot in the container config.
  IDX=0; while pct config "$TARGET_CTID" | grep -q "^mp${IDX}:"; do IDX=$((IDX+1)); done
  info "Binding into container $TARGET_CTID as mp${IDX} -> ${CT_PATH}"
  pct set "$TARGET_CTID" -mp${IDX} "${HOST_MP},mp=${CT_PATH}" \
    || die "pct set failed (could not add the bind mount to $TARGET_CTID)."
  ok "bind mount added to container config"
  warn "Restart the container to expose it live:  pct reboot ${TARGET_CTID}"
fi

cat <<DONE

${GN}Share ready.${NC}
  host mount   : ${HOST_MP}  (persists via /etc/fstab; survives reboot)
  source       : ${SRC} (${TYPE})
$( [[ -n "$CRED_FILE" ]] && echo "  credentials  : ${CRED_FILE} (root-only)" )
$( [[ -n "$TARGET_CTID" ]] && echo "  in CT ${TARGET_CTID} : ${CT_PATH}  (after: pct reboot ${TARGET_CTID})" )

Next: point qBittorrent's save path (and its 'radarr'/'sonarr' category paths) at
${CT_PATH:-$HOST_MP} so completed torrents land on the share. Re-run this script with
the same name to update the share; unprivileged containers may need the mount's
uid/gid options (TORHQ_SHARE_OPTS) set to your download user's mapped id for writes.
DONE
