#!/bin/sh
# docker-entrypoint.sh — configures Apache port from $PORT env var then starts Apache
# Render sets PORT=10000 by default; local Docker uses 80

PORT="${PORT:-80}"

# Update Apache to listen on $PORT
sed -i "s/^Listen 80$/Listen ${PORT}/" /etc/apache2/ports.conf
sed -i "s/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

echo "Starting Apache on port ${PORT}..."
exec apache2-foreground
