#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}

require_config() {
  : "${POSTGRES_HOST:?POSTGRES_HOST is required}"
  : "${POSTGRES_PORT:?POSTGRES_PORT is required}"
  : "${POSTGRES_DB:?POSTGRES_DB is required}"
  : "${POSTGRES_USER:?POSTGRES_USER is required}"
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
  : "${BACKUP_ENCRYPTION_PASSWORD:?BACKUP_ENCRYPTION_PASSWORD is required}"
  [ "${#BACKUP_ENCRYPTION_PASSWORD}" -ge 32 ] || {
    printf '%s\n' 'BACKUP_ENCRYPTION_PASSWORD must contain at least 32 characters' >&2
    exit 1
  }
  valid_integer "$BACKUP_INTERVAL_SECONDS" 3600 BACKUP_INTERVAL_SECONDS
  valid_integer "$BACKUP_RETENTION_DAYS" 1 BACKUP_RETENTION_DAYS
}

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

check_health() {
  [ -f "$BACKUP_DIR/.last-success" ] || exit 1
  last_success=$(cat "$BACKUP_DIR/.last-success")
  case "$last_success" in ''|*[!0-9]*) exit 1 ;; esac
  now=$(date +%s)
  maximum_age=$((BACKUP_INTERVAL_SECONDS + 3600))
  age=$((now - last_success))
  [ "$age" -ge 0 ] && [ "$age" -le "$maximum_age" ]
}

wait_for_postgres() {
  until PGPASSWORD="$POSTGRES_PASSWORD" pg_isready \
    --host "$POSTGRES_HOST" \
    --port "$POSTGRES_PORT" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" >/dev/null 2>&1; do
    sleep 5
  done
}

run_backup() {
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  final="$BACKUP_DIR/fuduo-$timestamp.dump.enc"
  temporary="$final.tmp"
  pipe_dir=$(mktemp -d)
  pipe="$pipe_dir/postgres.dump"
  mkfifo "$pipe"
  dump_pid=''

  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host "$POSTGRES_HOST" \
    --port "$POSTGRES_PORT" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --format custom \
    --no-owner \
    --no-acl >"$pipe" &
  dump_pid=$!

  encrypt_status=0
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$pipe" \
    -out "$temporary" || encrypt_status=$?

  dump_status=0
  wait "$dump_pid" || dump_status=$?
  dump_pid=''
  rm -rf "$pipe_dir"

  if [ "$encrypt_status" -ne 0 ] || [ "$dump_status" -ne 0 ]; then
    rm -f "$temporary"
    printf '%s\n' 'Encrypted PostgreSQL backup failed' >&2
    return 1
  fi

  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$temporary" | pg_restore --list >/dev/null; then
    rm -f "$temporary"
    printf '%s\n' 'Encrypted PostgreSQL backup verification failed' >&2
    return 1
  fi

  mv "$temporary" "$final"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" >"$(basename "$final").sha256")
  date +%s >"$BACKUP_DIR/.last-success.tmp"
  mv "$BACKUP_DIR/.last-success.tmp" "$BACKUP_DIR/.last-success"
  find "$BACKUP_DIR" -type f \( -name 'fuduo-*.dump.enc' -o -name 'fuduo-*.dump.enc.sha256' \) -mtime +"$BACKUP_RETENTION_DAYS" -delete
  printf '{"level":"info","event":"postgres.backup.completed","file":"%s","at":"%s"}\n' \
    "$(basename "$final")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

require_config
umask 077
mkdir -p "$BACKUP_DIR"
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tmp' -delete

if [ "${1:-}" = "--check" ]; then
  check_health
  exit 0
fi

trap 'exit 0' INT TERM
while :; do
  wait_for_postgres
  run_backup || true
  sleep "$BACKUP_INTERVAL_SECONDS" &
  wait $!
done
