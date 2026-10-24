#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh. See docs/DEPLOYMENT.md → Backups
# and restore. Always rehearse into an EMPTY database (staging, or a second
# database on the same host) before touching production.
#
#   deploy/restore.sh BACKUP_DIR [--env-file PATH] [--site-root DIR]
#                     [--db-only | --uploads-only] [--yes]
#
# DB_* are read like backup.sh (environment first, then --env-file). The target
# database must already exist and DB_USER must be able to DROP/CREATE tables in
# it — the dump recreates every table, so anything in the target is replaced.
# Uploads are extracted over <site-root>/uploads (existing files with the same
# name are overwritten; other files are left alone). config.tar.gz is never
# extracted automatically: it holds secrets and the target host usually has
# its own .env — the script tells you where it is.
set -euo pipefail

BACKUP_DIR=""
ENV_FILE=""
SITE_ROOT=""
MODE="all"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --site-root)    SITE_ROOT="$2"; shift 2 ;;
    --db-only)      MODE="db"; shift ;;
    --uploads-only) MODE="uploads"; shift ;;
    --yes|-y)       YES=1; shift ;;
    -h|--help)      sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done

[ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] || { echo "usage: restore.sh BACKUP_DIR [options]" >&2; exit 2; }
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$SITE_ROOT" ]; then
  if [ -d "$SCRIPT_DIR/../backend" ]; then SITE_ROOT="$(cd "$SCRIPT_DIR/../backend" && pwd)"; else SITE_ROOT="$(pwd)"; fi
fi
[ -n "$ENV_FILE" ] || { [ -f "$SITE_ROOT/../.env.local" ] && ENV_FILE="$(cd "$SITE_ROOT/.." && pwd)/.env.local"; } || true

if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }
  while IFS='=' read -r key value; do
    case "$key" in
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASS)
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        [ -n "${!key:-}" ] || export "$key=$value" ;;
    esac
  done < <(grep -E '^(DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASS)=' "$ENV_FILE" || true)
fi

echo "→ verifying checksums in $BACKUP_DIR"
[ -f "$BACKUP_DIR/MANIFEST.sha256" ] || { echo "no MANIFEST.sha256 — not a backup.sh folder" >&2; exit 2; }
( cd "$BACKUP_DIR" && sha256sum -c --quiet MANIFEST.sha256 ) || { echo "checksum mismatch — refusing to restore a damaged backup" >&2; exit 3; }
[ -f "$BACKUP_DIR/release.txt" ] && sed 's/^/  /' "$BACKUP_DIR/release.txt"

if [ "$MODE" != "uploads" ]; then
  : "${DB_HOST:=localhost}"
  : "${DB_PORT:=3306}"
  : "${DB_NAME:?DB_NAME is required (environment or --env-file)}"
  : "${DB_USER:?DB_USER is required (environment or --env-file)}"
  : "${DB_PASS:?DB_PASS is required (environment or --env-file)}"
  command -v mysql >/dev/null 2>&1 || { echo "missing tool: mysql" >&2; exit 2; }
  [ -f "$BACKUP_DIR/db.sql.gz" ] || { echo "no db.sql.gz in backup" >&2; exit 2; }
fi

if [ $YES -ne 1 ]; then
  echo
  [ "$MODE" != "uploads" ] && echo "This REPLACES every table in database '$DB_NAME' on $DB_HOST:$DB_PORT."
  [ "$MODE" != "db" ] && [ -f "$BACKUP_DIR/uploads.tar.gz" ] && echo "This overwrites files in $SITE_ROOT/uploads."
  printf "Type the database name to continue: "
  read -r answer
  [ "$answer" = "${DB_NAME:-uploads}" ] || { echo "aborted"; exit 1; }
fi

if [ "$MODE" != "uploads" ]; then
  CNF="$(mktemp)"
  trap 'rm -f "$CNF"' EXIT
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\ndefault-character-set=utf8mb4\n' \
    "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_PASS" > "$CNF"
  echo "→ restoring database $DB_NAME"
  gzip -dc "$BACKUP_DIR/db.sql.gz" | mysql --defaults-extra-file="$CNF" "$DB_NAME"
  TABLES="$(mysql --defaults-extra-file="$CNF" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")"
  echo "  $TABLES tables present"
fi

if [ "$MODE" != "db" ]; then
  if [ -f "$BACKUP_DIR/uploads.tar.gz" ]; then
    echo "→ restoring uploads into $SITE_ROOT"
    mkdir -p "$SITE_ROOT"
    tar -xzf "$BACKUP_DIR/uploads.tar.gz" -C "$SITE_ROOT"
    echo "  $(find "$SITE_ROOT/uploads" -type f | wc -l) files in uploads/"
    if [ ! -f "$SITE_ROOT/uploads/.htaccess" ] && [ -f "$SCRIPT_DIR/htaccess_uploads" ]; then
      cp "$SCRIPT_DIR/htaccess_uploads" "$SITE_ROOT/uploads/.htaccess"
      echo "  restored uploads/.htaccess from deploy/htaccess_uploads"
    fi
  else
    echo "→ no uploads.tar.gz in this backup, skipped"
  fi
fi

if [ -f "$BACKUP_DIR/config.tar.gz" ]; then
  echo "→ config.tar.gz holds the .env of the backed-up site; NOT extracted."
  echo "  Compare it with the target's variables by hand: tar -xzOf $BACKUP_DIR/config.tar.gz | sed 's/=.*/=…/'"
fi

echo "✓ restore finished. Now: sign in to /admin/, open the dashboard, load /api/announcements and one gallery image."
