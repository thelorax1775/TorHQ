#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# TorHQ — remove an NFS/SMB share created by scripts/mount-share.sh.
#
# Run this ON the Proxmox VE host (as root). It cleanly reverses a share:
# removes the bind mount from a container (optional), unmounts it on the host,
# deletes the fstab entry and the SMB credentials file, and (optionally) removes
# the now-empty mountpoint.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/unmount-share.sh)"
#
# Interactive by default (pick from existing shares); or drive it with TORHQ_*.
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

NAME="${TORHQ_SHARE_NAME:-}"
TARGET_CTID="${TORHQ_TARGET_CTID:-}"     # unbind from this container (optional)
HOST_BASE="${TORHQ_HOST_BASE:-/mnt/torhq-shares}"
REMOVE_DIR="${TORHQ_REMOVE_DIR:-1}"      # rmdir the empty mountpoint afterwards

[[ $EUID -eq 0 ]] || die "run as root on the Proxmox VE host."

# Names of shares this tooling created, discovered from the fstab markers.
mapfile -t SHARES < <(grep -oP '# torhq-share:\K\S+' /etc/fstab 2>/dev/null | sort -u)

INTERACTIVE=1
{ [[ -t 0 ]] && command -v whiptail >/dev/null && [[ -z "${TORHQ_NONINTERACTIVE:-}" ]]; } || INTERACTIVE=0

if [[ -z "$NAME" && "$INTERACTIVE" -eq 1 ]]; then
  [[ ${#SHARES[@]} -gt 0 ]] || die "no TorHQ-managed shares found in /etc/fstab."
  MENU=(); for s in "${SHARES[@]}"; do MENU+=("$s" "${HOST_BASE%/}/$s"); done
  NAME="$(whiptail --title "TorHQ unmount" --menu "Remove which share?" 18 70 8 "${MENU[@]}" 3>&1 1>&2 2>&3)" || cancel
  if [[ -z "$TARGET_CTID" ]] && command -v pct >/dev/null \
     && whiptail --title "TorHQ unmount" --yesno "Also remove its bind mount from a container?" 9 60; then
    TARGET_CTID="$(whiptail --title "TorHQ unmount" --inputbox "Container ID (CTID)" 10 60 3>&1 1>&2 2>&3)" || cancel
  fi
fi

[[ -n "$NAME" ]] || die "TORHQ_SHARE_NAME is required (which share to remove)."
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "invalid share name '$NAME'."
HOST_MP="${HOST_BASE%/}/${NAME}"

# 1. Remove the bind mount point from the container config (applies on reboot).
if [[ -n "$TARGET_CTID" ]]; then
  command -v pct >/dev/null || die "'pct' not found but a target CTID was given."
  pct status "$TARGET_CTID" &>/dev/null || die "container $TARGET_CTID does not exist."
  # Find the mpN entry whose host path is our mountpoint.
  SLOT="$(pct config "$TARGET_CTID" | awk -F: -v mp="$HOST_MP" '/^mp[0-9]+:/ && index($0, mp) { sub(/:.*/,""); print; exit }')"
  if [[ -n "$SLOT" ]]; then
    info "Removing $SLOT from container $TARGET_CTID"
    pct set "$TARGET_CTID" -delete "$SLOT" || die "pct set -delete $SLOT failed."
    ok "bind mount removed (reboot the container to apply: pct reboot $TARGET_CTID)"
  else
    warn "no bind mount for $HOST_MP found in container $TARGET_CTID (skipping)"
  fi
fi

# 2. Unmount on the host.
if mountpoint -q "$HOST_MP"; then
  info "Unmounting $HOST_MP"
  umount "$HOST_MP" 2>/dev/null || umount -l "$HOST_MP" || die "could not unmount $HOST_MP (is it in use?)."
  ok "unmounted"
else
  warn "$HOST_MP is not currently mounted (continuing)"
fi

# 3. Remove the fstab entry (marker line + the following mount line).
if grep -q "# torhq-share:${NAME}\$" /etc/fstab 2>/dev/null; then
  info "Removing /etc/fstab entry"
  sed -i "\%# torhq-share:${NAME}\$%,+1d" /etc/fstab
  ok "fstab entry removed"
fi

# 4. Remove the SMB credentials file, if any.
CRED="/etc/torhq-shares/${NAME}.cred"
[[ -f "$CRED" ]] && { rm -f "$CRED"; ok "removed credentials $CRED"; }

# 5. Remove the (now-empty) mountpoint.
if [[ "$REMOVE_DIR" == "1" && -d "$HOST_MP" ]]; then
  rmdir "$HOST_MP" 2>/dev/null && ok "removed mountpoint $HOST_MP" \
    || warn "mountpoint $HOST_MP not empty — left in place"
fi

echo
ok "Share '${NAME}' removed."
[[ -n "$TARGET_CTID" ]] && echo "  Reboot the container to drop the bind mount live:  pct reboot ${TARGET_CTID}"
