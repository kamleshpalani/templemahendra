<?php
// sqlite_seed.php — creates and seeds a local SQLite DB for development.
// Run once: php sqlite_seed.php

$dbPath = __DIR__ . '/dev.sqlite';

if (file_exists($dbPath)) {
    echo "dev.sqlite already exists. Delete it first to re-seed.\n";
    exit(0);
}

$pdo = new PDO('sqlite:' . $dbPath);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA journal_mode=WAL;');
$pdo->exec('PRAGMA foreign_keys=ON;');

$statements = [
"CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS sevas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ta     TEXT    NOT NULL,
  name_en     TEXT    NOT NULL,
  description TEXT,
  amount      REAL    NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
)",
"CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title_ta    TEXT NOT NULL,
  title_en    TEXT NOT NULL,
  description TEXT,
  event_date  TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
)",
"CREATE TABLE IF NOT EXISTS gallery (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT    NOT NULL,
  caption    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS donations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  amount     REAL NOT NULL,
  purpose    TEXT,
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS seva_bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  devotee_name   TEXT NOT NULL,
  phone          TEXT NOT NULL,
  seva_id        INTEGER,
  seva_name      TEXT NOT NULL,
  preferred_date TEXT,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS poojas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ta         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  description_ta  TEXT,
  description_en  TEXT,
  pooja_date      TEXT NOT NULL,
  pooja_time      TEXT,
  pooja_type      TEXT NOT NULL DEFAULT 'special',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS sponsors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  note       TEXT,
  pooja_id   INTEGER,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS homepage_widgets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  content_type       TEXT    NOT NULL DEFAULT 'announcement',
  title_ta           TEXT,
  title_en           TEXT,
  description_ta     TEXT,
  description_en     TEXT,
  source_type        TEXT    NOT NULL DEFAULT 'manual',
  linked_pooja_id    INTEGER,
  linked_sponsor_id  INTEGER,
  show_sponsor       INTEGER NOT NULL DEFAULT 0,
  show_nalla_neram   INTEGER NOT NULL DEFAULT 0,
  start_date         TEXT,
  end_date           TEXT,
  priority           INTEGER NOT NULL DEFAULT 10,
  is_pinned          INTEGER NOT NULL DEFAULT 0,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
)",
"CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 5,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)",
];

foreach ($statements as $sql) {
    $pdo->exec($sql);
}

// ── Seed data ─────────────────────────────────────────────────────────────────
$pdo->exec("INSERT INTO announcements (title, body, is_active) VALUES
('கோயில் திறக்கும் நேரம் மாற்றம்', 'இனி காலை 6 மணிக்கு திறக்கும். Morning opening changed to 6 AM.', 1),
('Special Abhishekam on New Moon Day', 'Grand Abhishekam every Amavasai at 7 AM. All are welcome.', 1),
('பௌர்ணமி பூஜை — ஏப்ரல் 13', 'நாளை பௌர்ணமி பூஜை மாலை 4 மணி முதல் 9 மணி வரை நடைபெறும்.', 1)");

$pdo->exec("INSERT INTO sevas (name_ta, name_en, description, amount, sort_order, is_featured, is_active) VALUES
('அபிஷேகம்',    'Abhishekam',      'Sacred bathing of the deity.',         251,  1, 1, 1),
('அர்ச்சனை',    'Archana',         'Flower offering with chanting.',        51,   2, 1, 1),
('தீபாராதனை',   'Deepa Aradhana',  'Sacred lamp waving.',                  101,  3, 1, 1),
('சகஸ்ர நாமம்','Sahasranama',     'Recitation of 1000 names.',            501,  4, 0, 1),
('அன்னதானம்',   'Annadanam',       'Sponsoring free meal for devotees.',  2001,  5, 1, 1),
('வாகன பூஜை',  'Vahana Pooja',    'Ceremonial procession of the vehicle.',1001,  6, 0, 1)");

$pdo->exec("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES
('தைப்பூசம்',        'Thai Poosam',       'Grand kavadi festival.',               '2026-01-24', 1),
('மகா சிவராத்திரி','Maha Shivaratri',     'All-night vigil and abhishekam.',      '2026-02-26', 1),
('பங்குனி உத்திரம்','Panguni Uthiram',   'Festival of divine celestial unions.',  '2026-03-31', 1),
('ஆடி பூரம்',        'Aadi Pooram',        'Celebration of Goddess Andal.',       '2026-07-28', 1),
('கார்த்திகை',       'Karthigai Deepam',   'Festival of lights.',                 '2026-11-27', 1)");

$pdo->exec("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active) VALUES
('பௌர்ணமி பூஜை', 'Pournami Poojai', '2026-04-13', '16:00', 'pournami', 1),
('பௌர்ணமி பூஜை', 'Pournami Poojai', '2026-05-12', '16:00', 'pournami', 1),
('பௌர்ணமி பூஜை', 'Pournami Poojai', '2026-06-11', '16:00', 'pournami', 1)");

$pdo->exec("INSERT INTO sponsors (name, note, is_active) VALUES
('குமார் குடும்பம்', 'பௌர்ணமி பூஜை நிதியுதவி', 1),
('செல்வி அம்மாள்',   'அன்னதான நிதியுதவி',       1)");

$pdo->exec("INSERT INTO donations (name, phone, amount, purpose) VALUES
('ராஜேஷ் குமார்', '9999900001', 1000, 'Pournami Poojai'),
('லட்சுமி தேவி',  '9999900002', 500,  'Annadanam'),
('மோகன் சர்மா',   '9999900003', 2001, 'Abhishekam')");

$pdo->exec("INSERT INTO reviews (author, body, rating, is_active) VALUES
('அனுஷா',     'மிகவும் அமைதியான கோவில். தெய்வீக சூழல் உள்ளது.', 5, 1),
('Ramesh K.', 'Very peaceful temple with great devotion.', 5, 1),
('பிரியா',    'பூஜை மிகவும் நன்றாக நடந்தது. நன்றி!',           5, 1)");

echo "✅ dev.sqlite created and seeded successfully!\n";
echo "   Path: $dbPath\n";
