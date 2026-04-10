<?php
// _setup.php — ONE-TIME schema installer. DELETE immediately after running.
// Access: https://templemahendra.onrender.com/_setup.php?token=SETUP_TOKEN_2026

declare(strict_types=1);

$token = $_GET['token'] ?? '';
if ($token !== 'SETUP_TOKEN_2026') {
    http_response_code(403);
    exit('Forbidden');
}

require_once __DIR__ . '/config/database.php';

function getDB(): PDO {
    $cfg = require __DIR__ . '/config/database.php';
    // Force TCP connection — prevent Unix socket fallback
    $dsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=%s',
        $cfg['host'], $cfg['port'], $cfg['name'], $cfg['charset']
    );
    return new PDO($dsn, $cfg['user'], $cfg['pass'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false,
    ]);
}

$statements = [
    "CREATE TABLE IF NOT EXISTS `announcements` (
      `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `title`      VARCHAR(300)    NOT NULL,
      `body`       TEXT            NULL,
      `is_active`  TINYINT(1)      NOT NULL DEFAULT 1,
      `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_active_date` (`is_active`, `created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `sevas` (
      `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `name_ta`     VARCHAR(200)    NOT NULL,
      `name_en`     VARCHAR(200)    NOT NULL,
      `description` TEXT            NULL,
      `amount`      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
      `sort_order`  INT             NOT NULL DEFAULT 0,
      `is_featured` TINYINT(1)      NOT NULL DEFAULT 0,
      `is_active`   TINYINT(1)      NOT NULL DEFAULT 1,
      PRIMARY KEY (`id`),
      KEY `idx_active_sort` (`is_active`, `sort_order`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `events` (
      `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `title_ta`    VARCHAR(300)    NOT NULL,
      `title_en`    VARCHAR(300)    NOT NULL,
      `description` TEXT            NULL,
      `event_date`  DATE            NOT NULL,
      `is_active`   TINYINT(1)      NOT NULL DEFAULT 1,
      PRIMARY KEY (`id`),
      KEY `idx_active_date` (`is_active`, `event_date`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `gallery` (
      `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `filename`   VARCHAR(255)    NOT NULL,
      `caption`    VARCHAR(500)    NULL,
      `is_active`  TINYINT(1)      NOT NULL DEFAULT 1,
      `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_active_date` (`is_active`, `created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `donations` (
      `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `name`       VARCHAR(200)    NOT NULL,
      `phone`      VARCHAR(20)     NOT NULL,
      `amount`     DECIMAL(12,2)   NOT NULL,
      `purpose`    VARCHAR(100)    NULL,
      `message`    TEXT            NULL,
      `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_date` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `contact_messages` (
      `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `name`       VARCHAR(200)    NOT NULL,
      `phone`      VARCHAR(20)     NOT NULL,
      `message`    TEXT            NOT NULL,
      `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    "CREATE TABLE IF NOT EXISTS `seva_bookings` (
      `id`             INT UNSIGNED    NOT NULL AUTO_INCREMENT,
      `devotee_name`   VARCHAR(200)    NOT NULL,
      `phone`          VARCHAR(20)     NOT NULL,
      `seva_id`        INT UNSIGNED    NULL,
      `seva_name`      VARCHAR(200)    NOT NULL,
      `preferred_date` DATE            NULL,
      `message`        TEXT            NULL,
      `status`         ENUM('pending','confirmed','completed','cancelled') NOT NULL DEFAULT 'pending',
      `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_status_date` (`status`, `created_at`),
      CONSTRAINT `fk_booking_seva` FOREIGN KEY (`seva_id`) REFERENCES `sevas` (`id`) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

    // Seed data
    "INSERT IGNORE INTO `announcements` (`id`, `title`, `body`, `is_active`) VALUES
      (1, 'கோயில் திறக்கும் நேரம் மாற்றம்', 'இனி காலை 6 மணிக்கு திறக்கும். Morning opening time changed to 6 AM.', 1),
      (2, 'Special Abhishekam on New Moon Day', 'Grand Abhishekam every Amavasai at 7 AM. All are welcome.', 1)",

    "INSERT IGNORE INTO `sevas` (`id`, `name_ta`, `name_en`, `description`, `amount`, `sort_order`, `is_featured`, `is_active`) VALUES
      (1, 'அபிஷேகம்',    'Abhishekam',     'Sacred bathing of the deity.',         251,  1, 1, 1),
      (2, 'அர்ச்சனை',     'Archana',        'Flower offering with chanting.',        51,  2, 1, 1),
      (3, 'தீபாராதனை',    'Deepa Aradhana', 'Sacred lamp waving.',                  101,  3, 1, 1),
      (4, 'சகஸ்ர நாமம்', 'Sahasranama',    'Recitation of 1000 names.',            501,  4, 0, 1),
      (5, 'அன்னதானம்',   'Annadanam',      'Sponsoring free meal for devotees.',  2001,  5, 1, 1),
      (6, 'வாகன பூஜை',   'Vahana Pooja',   'Ceremonial procession of the vehicle.',1001, 6, 0, 1)",

    "INSERT IGNORE INTO `events` (`id`, `title_ta`, `title_en`, `description`, `event_date`, `is_active`) VALUES
      (1, 'தைப்பூசம்',        'Thai Poosam',      'Grand kavadi festival.',              '2026-01-24', 1),
      (2, 'மகா சிவராத்திரி', 'Maha Shivaratri',  'All-night vigil and abhishekam.',     '2026-02-26', 1),
      (3, 'பங்குனி உத்திரம்', 'Panguni Uthiram', 'Festival of divine celestial unions.','2026-03-31', 1),
      (4, 'ஆடி பூரம்',        'Aadi Pooram',      'Celebration of Goddess Andal.',      '2026-07-28', 1),
      (5, 'கார்த்திகை',       'Karthigai Deepam', 'Festival of lights.',                '2026-11-27', 1)",
];

$results = [];
try {
    $pdo = getDB();
    foreach ($statements as $stmt) {
        try {
            $pdo->exec($stmt);
            $first = trim(strtok(trim($stmt), "\n"));
            $results[] = ['ok', substr($first, 0, 80)];
        } catch (PDOException $e) {
            $first = trim(strtok(trim($stmt), "\n"));
            $results[] = ['err', substr($first, 0, 80), $e->getMessage()];
        }
    }
    $status = 'SUCCESS';
} catch (PDOException $e) {
    $status = 'DB CONNECTION FAILED: ' . $e->getMessage();
}

header('Content-Type: text/plain; charset=utf-8');
echo "=== Temple Mahendra — Schema Setup ===\n";
echo "Status: $status\n\n";
foreach ($results as $r) {
    echo ($r[0] === 'ok' ? '  ✓ ' : '  ✗ ') . $r[1] . "\n";
    if ($r[0] === 'err') echo "    ERROR: " . $r[2] . "\n";
}
echo "\nDone. DELETE this file from the server now.\n";
