#!/bin/sh
set -eu

REPOSITORY="${FUDUO_GITHUB_REPOSITORY:-01121531/FUDUO}"
MODE="docker"
REQUESTED_VERSION=""
ROLLBACK_VERSION=""

usage() {
  printf '%s\n' "Usage: update.sh [--mode docker|source] [--version vX.Y.Z] [--rollback vX.Y.Z]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --version) REQUESTED_VERSION="${2:-}"; shift 2 ;;
    --rollback) ROLLBACK_VERSION="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case "$MODE" in docker|source) ;; *) usage >&2; exit 2 ;; esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR="$ROOT/.updates"
VERSION_FILE="$STATE_DIR/current-version"
mkdir -p "$STATE_DIR"

latest_version() {
  REPOSITORY="$REPOSITORY" node -e '
    const repo = process.env.REPOSITORY;
    fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "fuduo-updater" },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const body = await response.json();
      if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(body.tag_name)) throw new Error("Invalid release tag");
      process.stdout.write(body.tag_name);
    }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
  '
}

validate_version() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || {
    printf '%s\n' "Invalid version: $1" >&2
    exit 2
  }
}

current_version() {
  if [ -f "$VERSION_FILE" ]; then cat "$VERSION_FILE"; return; fi
  git -C "$ROOT" describe --tags --exact-match 2>/dev/null || printf '%s' "unknown"
}

docker_update() {
  command -v docker >/dev/null 2>&1 || { printf '%s\n' "Docker is required for docker mode." >&2; exit 1; }
  docker compose version >/dev/null
  old_version=$(current_version)
  export FUDUO_IMAGE_TAG="$1"
  base="$ROOT/deploy/docker-compose.yml"
  release="$ROOT/deploy/docker-compose.release.yml"

  docker compose -f "$base" -f "$release" pull
  if ! docker compose -f "$base" -f "$release" up -d --remove-orphans --wait; then
    if [ "$old_version" != "unknown" ]; then
      printf '%s\n' "Update failed; restoring $old_version." >&2
      export FUDUO_IMAGE_TAG="$old_version"
      docker compose -f "$base" -f "$release" up -d --remove-orphans --wait
    fi
    exit 1
  fi
  printf '%s\n' "$1" > "$VERSION_FILE"
}

source_update() {
  command -v git >/dev/null 2>&1 || { printf '%s\n' "Git is required for source mode." >&2; exit 1; }
  command -v pnpm >/dev/null 2>&1 || { printf '%s\n' "pnpm is required for source mode." >&2; exit 1; }
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || { printf '%s\n' "Source tree has local changes; update aborted." >&2; exit 1; }
  old_revision=$(git -C "$ROOT" rev-parse HEAD)
  git -C "$ROOT" fetch --tags origin
  git -C "$ROOT" rev-parse --verify "refs/tags/$1" >/dev/null
  git -C "$ROOT" checkout --detach "$1"
  if ! (cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build); then
    git -C "$ROOT" checkout --detach "$old_revision"
    (cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build) || true
    exit 1
  fi
  if [ -n "${FUDUO_RESTART_COMMAND:-}" ]; then sh -c "$FUDUO_RESTART_COMMAND"; fi
  printf '%s\n' "$1" > "$VERSION_FILE"
}

target="$ROLLBACK_VERSION"
[ -n "$target" ] || target="$REQUESTED_VERSION"
[ -n "$target" ] || target=$(latest_version)
validate_version "$target"

printf '%s\n' "Updating FUDUO from $(current_version) to $target using $MODE mode."
if [ "$MODE" = "docker" ]; then docker_update "$target"; else source_update "$target"; fi
printf '%s\n' "FUDUO is now on $target."
