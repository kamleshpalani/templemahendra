#!/usr/bin/env bash
# Full site backup: database dump + uploaded media + configuration + release
# reference. See docs/DEPLOYMENT.md → Backups and restore.
#
#   deploy/backup.sh [--env-file PATH] [--site-root DIR] [--out DIR] [--keep N]
#
# Reads DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS from the environment or
# from --env-file (a KEY=value file; defaults to .env.local next to the site
# root when present — the app itself reads hPanel variables in production).
# --site-root is the directory that holds uploads/ (default:
# the repo's backend/ when run from a checkout, or the current directory).
# --out is where the dated backup folder is created (default: <site-root>/../backups,
# i.e. NEXT TO public_html, never inside it). --keep prunes to the newest N
# folders (default: keep everything).
#
# Produces <out>/<YYYYmmdd-HHMMSS>/ with
#   db.sql.gz        mysqldump --single-transaction, routines, triggers, utf8mb4
#   uploads.tar.gz   the uploads folder (gallery, banners, thumbnails)
#   config.tar.gz    the env file if one was found/given (mode 600 — it holds secrets)
#   release.txt      git commit / branch (or "unknown"), host, PHP and MySQL versions
#   MANIFEST.sha256  checksums of the above, verified by restore.sh
set -euo pipefail

ENV_FILE=""
SITE_ROOT=""
OUT=""
KEEP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)  ENV_FILE="$2"; shift 2 ;;
    --site-root) SITE_ROOT="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --keep)      KEEP="$2"; shift 2 ;;
    -h|--help)   sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$SITE_ROOT" ]; then
  if [ -d "$SCRIPT_DIR/../backend" ]; then SITE_ROOT="$(cd "$SCRIPT_DIR/../backend" && pwd)"; else SITE_ROOT="$(pwd)"; fi
fi
[ -n "$ENV_FILE" ] || { [ -f "$SITE_ROOT/../.env.local" ] && ENV_FILE="$(cd "$SITE_ROOT/.." && pwd)/.env.local"; } || true

if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 2; }
  # Only the DB_* lines are read; nothing else from the file is exported.
  while IFS='=' read -r key value; do
    case "$key" in
      DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASS)
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        [ -n "${!key:-}" ] || export "$key=$value" ;;
    esac
  done < <(grep -E '^(DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASS)=' "$ENV_FILE" || true)
fi

: "${DB_HOST:=localhost}"
: "${DB_PORT:=3306}"
: "${DB_NAME:?DB_NAME is required (environment or --env-file)}"
: "${DB_USER:?DB_USER is required (environment or --env-file)}"
: "${DB_PASS:?DB_PASS is required (environment or --env-file)}"

for tool in mysqldump tar gzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 2; }
done

[ -n "$OUT" ] || OUT="$(cd "$SITE_ROOT/.." && pwd)/backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$OUT/$STAMP"
umask 077
mkdir -p "$DEST"

# The password goes through a temporary option file, never the command line
# (where `ps` would show it).
CNF="$(mktemp)"
trap 'rm -f "$CNF"' EXIT
printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\ndefault-character-set=utf8mb4\n' \
  "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_PASS" > "$CNF"

echo "→ database $DB_NAME @ $DB_HOST:$DB_PORT"
mysqldump --defaults-extra-file="$CNF" \
  --single-transaction --quick --routines --triggers --events \
  --set-gtid-purged=OFF --no-tablespaces --hex-blob \
  --skip-comments --skip-dump-date \
  "$DB_NAME" | gzip -9 > "$DEST/db.sql.gz"

if [ -d "$SITE_ROOT/uploads" ]; then
  echo "→ uploads ($SITE_ROOT/uploads)"
  tar -czf "$DEST/uploads.tar.gz" -C "$SITE_ROOT" uploads
else
  echo "→ uploads: no $SITE_ROOT/uploads folder, skipped"
fi

if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  echo "→ config ($ENV_FILE)"
  tar -czf "$DEST/config.tar.gz" -C "$(dirname "$ENV_FILE")" "$(basename "$ENV_FILE")"
  chmod 600 "$DEST/config.tar.gz"
else
  echo "→ config: no env file, skipped (record the hosting-panel variables by hand)"
fi

{
  echo "taken_at_utc=$STAMP"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  echo "database=$DB_NAME"
  if command -v git >/dev/null 2>&1 && git -C "$SCRIPT_DIR" rev-parse HEAD >/dev/null 2>&1; then
    echo "git_commit=$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
    echo "git_branch=$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD)"
  else
    echo "git_commit=unknown"
  fi
  command -v php >/dev/null 2>&1 && echo "php=$(php -r 'echo PHP_VERSION;')" || true
  echo "mysqldump=$(mysqldump --version | head -1)"
  echo "site_root=$SITE_ROOT"
} > "$DEST/release.txt"

( cd "$DEST" && sha256sum db.sql.gz release.txt $( [ -f uploads.tar.gz ] && echo uploads.tar.gz ) $( [ -f config.tar.gz ] && echo config.tar.gz ) > MANIFEST.sha256 )

if [ -n "$KEEP" ] && [ "$KEEP" -gt 0 ] 2>/dev/null; then
  ls -1d "$OUT"/[0-9]*-[0-9]* 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
    echo "→ pruning $old"; rm -rf "$old"
  done
fi

echo "✓ backup written to $DEST"
du -sh "$DEST" | awk '{print "  size: " $1}'
