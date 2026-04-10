<?php
// backend/config/database.php
// Credentials loaded from environment variables — never hardcode in production.

if (!function_exists('dbEnv')) {
    /**
     * Read an env var from getenv(), $_ENV, or $_SERVER.
     * Apache + Docker sometimes only exposes vars via $_SERVER.
     */
    function dbEnv(string $key, string $default = ''): string
    {
        $val = getenv($key);
        if ($val !== false && $val !== '') return $val;
        if (!empty($_ENV[$key]))    return (string) $_ENV[$key];
        if (!empty($_SERVER[$key])) return (string) $_SERVER[$key];
        return $default;
    }
}

return [
    'host'    => dbEnv('DB_HOST', 'localhost'),
    'port'    => dbEnv('DB_PORT', '3306'),
    'name'    => dbEnv('DB_NAME', 'templemahendra'),
    'user'    => dbEnv('DB_USER', 'root'),
    'pass'    => dbEnv('DB_PASS', ''),
    'charset' => 'utf8mb4',
];
