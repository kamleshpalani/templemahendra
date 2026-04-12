#!/bin/sh
# docker-entrypoint.sh — configures Apache port from $PORT env var then starts Apache
# Render sets PORT=10000 by default; local Docker uses 80

PORT="${PORT:-80}"

# Update Apache to listen on $PORT
sed -i "s/^Listen 80$/Listen ${PORT}/" /etc/apache2/ports.conf
sed -i "s/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

# Write all Render env vars to a PHP bootstrap file using base64 encoding
# so special characters in passwords are handled safely.
# PHP auto_prepend_file loads this before every script (see runtime-env.ini).
PHP_BOOT="/var/www/html/config/runtime_env.php"
printf '<?php\n' > "$PHP_BOOT"
for _var in DB_HOST DB_PORT DB_NAME DB_USER DB_PASS CORS_ORIGIN \
            ADMIN_USERNAME ADMIN_PASS_HASH \
            GEMINI_API_KEY GOOGLE_PLACES_API_KEY GOOGLE_PLACE_ID; do
    _val=$(eval "printf '%s' \"\${$_var}\"" 2>/dev/null || true)
    if [ -n "$_val" ]; then
        _b64=$(printf '%s' "$_val" | base64 | tr -d '\n\r')
        printf 'putenv("%s=".base64_decode("%s"));\n' "$_var" "$_b64" >> "$PHP_BOOT"
        printf '$_ENV["%s"]=base64_decode("%s");\n'   "$_var" "$_b64" >> "$PHP_BOOT"
        printf '$_SERVER["%s"]=base64_decode("%s");\n' "$_var" "$_b64" >> "$PHP_BOOT"
    fi
done

# ── SQLite: initialise database on first boot ─────────────────────────────────
DB_PATH="${DB_PATH:-/data/temple.sqlite}"
if [ ! -f "$DB_PATH" ]; then
    echo "SQLite database not found at ${DB_PATH}. Initialising..."
    DB_PATH="$DB_PATH" php /var/www/html/sqlite_seed.php && \
        echo "Database initialised." || echo "WARNING: DB init failed."
    chown www-data:www-data "$DB_PATH" 2>/dev/null || true
fi

echo "Starting Apache on port ${PORT}..."
exec apache2-foreground
