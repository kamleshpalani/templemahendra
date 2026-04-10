# ── Sri Mahendra Temple — PHP 8.2 + Apache on Render ──────────────────────────
FROM php:8.2-apache

# Enable Apache modules
RUN a2enmod rewrite headers

# Install PDO MySQL extension
RUN docker-php-ext-install pdo pdo_mysql

# Copy backend source into web root
COPY backend/ /var/www/html/

# Apache virtualhost — routes /api/* through the PHP router
# and serves /admin/* directly
RUN cat > /etc/apache2/sites-available/000-default.conf <<'APACHECONF'
<VirtualHost *:80>
    DocumentRoot /var/www/html

    # ── Public API (/api/*) ─────────────────────────────────────────
    <Directory /var/www/html/api>
        Options -Indexes
        AllowOverride None
        Require all granted

        RewriteEngine On
        # Pass through real PHP files (e.g. pulse.php direct access)
        RewriteCond %{REQUEST_FILENAME} !-f
        # Route everything else to index.php router
        RewriteRule ^ index.php [QSA,L]
    </Directory>

    # ── Admin panel (/admin/*) ──────────────────────────────────────
    <Directory /var/www/html/admin>
        Options -Indexes
        AllowOverride None
        Require all granted
    </Directory>

    # ── Uploads (read-only static) ──────────────────────────────────
    <Directory /var/www/html/uploads>
        Options -Indexes -ExecCGI
        AllowOverride None
        Require all granted
        php_flag engine off
    </Directory>

    # Security headers
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header unset Server
    Header unset X-Powered-By
</VirtualHost>
APACHECONF

# Expose port 80
EXPOSE 80

# Health check (Render uses it to confirm startup)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost/api/sevas || exit 1
