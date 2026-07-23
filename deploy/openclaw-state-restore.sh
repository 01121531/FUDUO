#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
RESTORE_TARGET=${OPENCLAW_RESTORE_TARGET:-/restore}

usage() {
  printf '%s\n' \
    'Usage: openclaw-state-restore --verify <openclaw-*.tar.gz.enc>' \
    '       openclaw-state-restore --restore <openclaw-*.tar.gz.enc>' >&2
  exit 2
}

require_backup() {
  file=${1:-${RESTORE_FILE:-}}
  case "$file" in
    openclaw-*.tar.gz.enc) ;;
    *) printf '%s\n' 'RESTORE_FILE must be an openclaw-*.tar.gz.enc basename' >&2; exit 2 ;;
  esac
  case "$file" in */*|*\\*) printf '%s\n' 'RESTORE_FILE must not contain a path' >&2; exit 2 ;; esac
  archive="$BACKUP_DIR/$file"
  checksum_file="$archive.sha256"
  [ -f "$archive" ] && [ -r "$archive" ] || {
    printf '%s\n' 'Encrypted OpenClaw backup is not readable' >&2
    exit 1
  }
  [ -f "$checksum_file" ] && [ -r "$checksum_file" ] || {
    printf '%s\n' 'OpenClaw backup checksum is not readable' >&2
    exit 1
  }
}

verify_checksum() {
  expected=$(sed -n '1s/[[:space:]].*$//p' "$checksum_file")
  case "$expected" in ''|*[!0-9a-fA-F]*) printf '%s\n' 'OpenClaw backup checksum is invalid' >&2; exit 1 ;; esac
  [ "${#expected}" -eq 64 ] || {
    printf '%s\n' 'OpenClaw backup checksum is invalid' >&2
    exit 1
  }
  actual=$(sha256sum "$archive" | sed 's/[[:space:]].*$//')
  [ "$actual" = "$expected" ] || {
    printf '%s\n' 'OpenClaw backup checksum does not match' >&2
    exit 1
  }
}

verify_archive() {
  verify_checksum
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$archive" | tar -tzf - >/dev/null; then
    printf '%s\n' 'Encrypted OpenClaw backup cannot be restored' >&2
    exit 1
  fi
}

restore_archive() {
  [ "$RESTORE_TARGET" = "/restore" ] || {
    printf '%s\n' 'OPENCLAW_RESTORE_TARGET must be the isolated /restore mount' >&2
    exit 2
  }
  [ "${RESTORE_CONFIRM_PATH:-}" = "$RESTORE_TARGET" ] || {
    printf '%s\n' 'RESTORE_CONFIRM_PATH must exactly match /restore' >&2
    exit 2
  }
  [ -d "$RESTORE_TARGET" ] && [ -w "$RESTORE_TARGET" ] || {
    printf '%s\n' 'The isolated OpenClaw restore target is not writable' >&2
    exit 1
  }
  if [ -n "$(find "$RESTORE_TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    [ "${RESTORE_REPLACE:-false}" = "true" ] || {
      printf '%s\n' 'OpenClaw restore target is not empty; set RESTORE_REPLACE=true to reset the drill volume' >&2
      exit 2
    }
    find "$RESTORE_TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  fi

  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$archive" | tar -xzf - -C "$RESTORE_TARGET" --no-same-owner --no-same-permissions; then
    find "$RESTORE_TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    printf '%s\n' 'OpenClaw state restore failed; the incomplete drill target was cleared' >&2
    exit 1
  fi
  printf '{"status":"restored","target":"/restore","archive":"%s"}\n' "$file"
}

: "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
[ "${#BACKUP_ENCRYPTION_PASSWORD}" -ge 32 ] || {
  printf '%s\n' 'BACKUP_ENCRYPTION_PASSWORD must contain at least 32 characters' >&2
  exit 1
}
umask 077

action=${1:-}
[ "$action" = "--verify" ] || [ "$action" = "--restore" ] || usage
require_backup "${2:-}"
verify_archive

if [ "$action" = "--verify" ]; then
  printf '{"status":"verified","archive":"%s"}\n' "$file"
  exit 0
fi
restore_archive
