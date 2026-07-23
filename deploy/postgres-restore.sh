#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_MAINTENANCE_DB=${POSTGRES_MAINTENANCE_DB:-postgres}

usage() {
  printf '%s\n' \
    'Usage: postgres-restore --verify <fuduo-*.dump.enc>' \
    '       postgres-restore --restore <fuduo-*.dump.enc>' >&2
  exit 2
}

require_backup() {
  file=${1:-${RESTORE_FILE:-}}
  case "$file" in
    fuduo-*.dump.enc) ;;
    *) printf '%s\n' 'RESTORE_FILE must be a fuduo-*.dump.enc basename' >&2; exit 2 ;;
  esac
  case "$file" in */*|*\\*) printf '%s\n' 'RESTORE_FILE must not contain a path' >&2; exit 2 ;; esac

  archive="$BACKUP_DIR/$file"
  checksum_file="$archive.sha256"
  [ -f "$archive" ] && [ -r "$archive" ] || {
    printf '%s\n' 'Encrypted PostgreSQL backup is not readable' >&2
    exit 1
  }
  [ -f "$checksum_file" ] && [ -r "$checksum_file" ] || {
    printf '%s\n' 'PostgreSQL backup checksum is not readable' >&2
    exit 1
  }
}

verify_checksum() {
  expected=$(sed -n '1s/[[:space:]].*$//p' "$checksum_file")
  case "$expected" in ''|*[!0-9a-fA-F]*) printf '%s\n' 'PostgreSQL backup checksum is invalid' >&2; exit 1 ;; esac
  [ "${#expected}" -eq 64 ] || {
    printf '%s\n' 'PostgreSQL backup checksum is invalid' >&2
    exit 1
  }
  actual=$(sha256sum "$archive" | sed 's/[[:space:]].*$//')
  [ "$actual" = "$expected" ] || {
    printf '%s\n' 'PostgreSQL backup checksum does not match' >&2
    exit 1
  }
}

verify_archive() {
  verify_checksum
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$archive" | pg_restore --list >/dev/null; then
    printf '%s\n' 'Encrypted PostgreSQL backup cannot be restored' >&2
    exit 1
  fi
}

require_database_config() {
  : "${POSTGRES_HOST:?POSTGRES_HOST is required}"
  : "${POSTGRES_USER:?POSTGRES_USER is required}"
  : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
  : "${POSTGRES_DB:?POSTGRES_DB is required}"
  : "${RESTORE_TARGET_DB:?RESTORE_TARGET_DB is required}"
  case "$RESTORE_TARGET_DB" in
    [A-Za-z_]* ) ;;
    *) printf '%s\n' 'RESTORE_TARGET_DB is invalid' >&2; exit 2 ;;
  esac
  case "$RESTORE_TARGET_DB" in *[!A-Za-z0-9_]* ) printf '%s\n' 'RESTORE_TARGET_DB is invalid' >&2; exit 2 ;; esac
  [ "${#RESTORE_TARGET_DB}" -le 63 ] || {
    printf '%s\n' 'RESTORE_TARGET_DB is invalid' >&2
    exit 2
  }
  [ "$RESTORE_TARGET_DB" != "$POSTGRES_DB" ] || {
    printf '%s\n' 'Refusing to restore over the configured production database' >&2
    exit 2
  }
  [ "${RESTORE_CONFIRM_DATABASE:-}" = "$RESTORE_TARGET_DB" ] || {
    printf '%s\n' 'RESTORE_CONFIRM_DATABASE must exactly match RESTORE_TARGET_DB' >&2
    exit 2
  }
}

restore_archive() {
  require_database_config
  PGHOST=$POSTGRES_HOST
  PGPORT=$POSTGRES_PORT
  PGUSER=$POSTGRES_USER
  PGPASSWORD=$POSTGRES_PASSWORD
  export PGHOST PGPORT PGUSER PGPASSWORD

  exists=$(psql --dbname "$POSTGRES_MAINTENANCE_DB" --tuples-only --no-align \
    --command "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_TARGET_DB'" | tr -d '[:space:]')
  if [ "$exists" = "1" ]; then
    [ "${RESTORE_REPLACE:-false}" = "true" ] || {
      printf '%s\n' 'Restore target already exists; use a new drill database or set RESTORE_REPLACE=true' >&2
      exit 2
    }
    dropdb --force "$RESTORE_TARGET_DB"
  fi

  createdb --encoding UTF8 --template template0 "$RESTORE_TARGET_DB"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass env:BACKUP_ENCRYPTION_PASSWORD \
    -in "$archive" | pg_restore \
      --dbname "$RESTORE_TARGET_DB" \
      --no-owner \
      --no-acl \
      --exit-on-error; then
    dropdb --force "$RESTORE_TARGET_DB" || true
    printf '%s\n' 'PostgreSQL restore failed; the incomplete drill database was removed' >&2
    exit 1
  fi

  migration_table=$(psql --dbname "$RESTORE_TARGET_DB" --tuples-only --no-align \
    --command "SELECT CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0 ELSE 1 END" | tr -d '[:space:]')
  [ "$migration_table" = "1" ] || {
    printf '%s\n' 'Restored database does not contain Prisma migration history' >&2
    exit 1
  }
  failed_migrations=$(psql --dbname "$RESTORE_TARGET_DB" --tuples-only --no-align \
    --command 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL' | tr -d '[:space:]')
  [ "$failed_migrations" = "0" ] || {
    printf '%s\n' 'Restored database contains an unfinished Prisma migration' >&2
    exit 1
  }
  printf '{"status":"restored","database":"%s","archive":"%s"}\n' "$RESTORE_TARGET_DB" "$file"
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
