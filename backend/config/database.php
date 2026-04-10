<?php
// backend/config/database.php
// Credentials loaded from environment variable or .env file — never hardcode in production.

return [
    'host'    => getenv('DB_HOST')     ?: 'localhost',
    'name'    => getenv('DB_NAME')     ?: 'templemahendra',
    'user'    => getenv('DB_USER')     ?: 'root',
    'pass'    => getenv('DB_PASS')     ?: '',
    'charset' => 'utf8mb4',
];
