#!/bin/sh
set -eu

STATE_DIR=${OPENCLAW_STATE_DIR:-/state}
BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
SUCCESS_FILE="$BACKUP_DIR/.openclaw-last-success"

valid_integer() {
  value=$1
  minimum=$2
  name=$3
  case "$value" in
    ''|*[!0-9]*) printf '%s must be an integer\n' "$name" >&2; exit 1 ;;
  esac
  [ "$value" -ge "$minimum" ] || {
    printf '%s must be at least %s\n' "$name" "$minimum" >&2
    exit 1
  }
}

require_config() {
  : "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
  [ "${#BACKUP_ENCRYPTION_PASSWORD}" -ge 32 ] || {
    printf '%s\n' 'BACKUP_ENCRYPTION_PASSWORD must contain at least 32 characters' >&2
    exit 1
  }
  [ -d "$STATE_DIR" ] && [ -r "$STATE_DIR" ] || {
    printf '%s\n' 'OPENCLAW_STATE_DIR must be a readable directory' >&2
    exit 1
  }
  valid_integer "$BACKUP_INTERVAL_SECONDS" 3600 BACKUP_INTERVAL_SECONDS
  valid_integer "$BACKUP_RETENTION_DAYS" 1 BACKUP_RETENTION_DAYS
}

check_health() {
  [ -f "$SUCCESS_FILE" ] || exit 1
  last_success=$(cat "$SUCCESS_FILE")
  case "$last_success" in ''|*[!0-9]*) exit 1 ;; esac
  now=$(date +%s)
  maximum_age=$((BACKUP_INTERVAL_SECONDS + 3600))
  age=$((now - last_success))
  [ "$age" -ge 0 ] && [ "$age" -le "$maximum_age" ]
}

run_backup() {
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  final="$BACKUP_DIR/openclaw-$timestamp.tar.gz.enc"
  temporary="$final.tmp"
  pipe_dir=$(mktemp -d)
  pipe="$pipe_dir/openclaw.tar.gz"
  mkfifo "$pipe"

  tar --exclude='./logs' --exclude='*.tmp' -C "$STATE_DIR" -czf - . >"$pipe" &
  tar_pid=$!

  encrypt_status=0
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$pipe" \
    -out "$temporary" || encrypt_status=$?

  tar_status=0
  wait "$tar_pid" || tar_status=$?
  rm -rf "$pipe_dir"

  if [ "$encrypt_status" -ne 0 ] || [ "$tar_status" -ne 0 ]; then
    rm -f "$temporary"
    printf '%s\n' 'Encrypted OpenClaw state backup failed' >&2
    return 1
  fi

  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$temporary" | tar -tzf - >/dev/null; then
    rm -f "$temporary"
    printf '%s\n' 'Encrypted OpenClaw state backup verification failed' >&2
    return 1
  fi

  mv "$temporary" "$final"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
  date +%s >"$SUCCESS_FILE.tmp"
  mv "$SUCCESS_FILE.tmp" "$SUCCESS_FILE"
  find "$BACKUP_DIR" -type f \( -name 'openclaw-*.tar.gz.enc' -o -name 'openclaw-*.tar.gz.enc.sha256' \) -mtime +"$BACKUP_RETENTION_DAYS" -delete
  printf '{"level":"info","event":"openclaw.backup.completed","file":"%s","at":"%s"}\n' \
    "$(basename "$final")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

require_config
umask 077
mkdir -p "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openclaw-*.tmp' -delete

if [ "${1:-}" = "--check" ]; then
  check_health
  exit 0
fi

if [ "${1:-}" = "--once" ]; then
  run_backup
  exit 0
fi

trap 'exit 0' INT TERM
while :; do
  if run_backup; then
    delay=$BACKUP_INTERVAL_SECONDS
  else
    delay=300
  fi
  sleep "$delay" &
  wait $!
done
