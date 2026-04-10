#!/bin/sh
# docker-entrypoint.sh — configures Apache port from $PORT env var then starts Apache
# Render sets PORT=10000 by default; local Docker uses 80

PORT="${PORT:-80}"

# Update Apache to listen on $PORT
sed -i "s/^Listen 80$/Listen ${PORT}/" /etc/apache2/ports.conf
sed -i "s/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

# Write Render environment variables into Apache's envvars so PHP can read them
# via getenv(). Apache does not inherit the process environment by default.
{
  [ -n "$DB_HOST" ]          && echo "export DB_HOST='$DB_HOST'"
  [ -n "$DB_NAME" ]          && echo "export DB_NAME='$DB_NAME'"
  [ -n "$DB_USER" ]          && echo "export DB_USER='$DB_USER'"
  [ -n "$DB_PASS" ]          && echo "export DB_PASS='$DB_PASS'"
  [ -n "$DB_PORT" ]          && echo "export DB_PORT='$DB_PORT'"
  [ -n "$CORS_ORIGIN" ]      && echo "export CORS_ORIGIN='$CORS_ORIGIN'"
  [ -n "$ADMIN_USERNAME" ]   && echo "export ADMIN_USERNAME='$ADMIN_USERNAME'"
  [ -n "$ADMIN_PASS_HASH" ]  && echo "export ADMIN_PASS_HASH='$ADMIN_PASS_HASH'"
  [ -n "$GEMINI_API_KEY" ]   && echo "export GEMINI_API_KEY='$GEMINI_API_KEY'"
  [ -n "$GOOGLE_PLACES_API_KEY" ] && echo "export GOOGLE_PLACES_API_KEY='$GOOGLE_PLACES_API_KEY'"
  [ -n "$GOOGLE_PLACE_ID" ]  && echo "export GOOGLE_PLACE_ID='$GOOGLE_PLACE_ID'"
} >> /etc/apache2/envvars

echo "Starting Apache on port ${PORT}..."
exec apache2-foreground
