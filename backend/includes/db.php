<?php
// backend/includes/db.php — Returns a singleton PDO connection.
// Priority: 1) DB_PATH env var (SQLite, production/Docker)
//           2) dev.sqlite file (SQLite, local dev)
//           3) MySQL via DB_HOST env vars (legacy fallback)

function getDB(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    // ── 1. Explicit SQLite path via env var (Render / Docker production) ────
    $dbPath = getenv('DB_PATH') ?: ($_ENV['DB_PATH'] ?? ($_SERVER['DB_PATH'] ?? ''));
    if ($dbPath !== '') {
        $pdo = new PDO('sqlite:' . $dbPath, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
        return $pdo;
    }

    // ── 2. Local SQLite fallback (dev.sqlite exists in backend dir) ─────────
    $sqlitePath = __DIR__ . '/../dev.sqlite';
    if (file_exists($sqlitePath)) {
        $pdo = new PDO('sqlite:' . $sqlitePath, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA foreign_keys=ON;');
        return $pdo;
    }

    // ── 3. MySQL (legacy — requires DB_HOST env var) ─────────────────────────
    $cfg = require __DIR__ . '/../config/database.php';

    $dsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=%s',
        $cfg['host'],
        $cfg['port'],
        $cfg['name'],
        $cfg['charset']
    );

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false,
    ];

    $pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], $options);
    return $pdo;
}
