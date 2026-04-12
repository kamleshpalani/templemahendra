<?php
$pdo = new PDO('sqlite:dev.sqlite');
$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
echo "\n=== SQLite Tables ===\n";
foreach ($tables as $t) {
    $count = $pdo->query("SELECT COUNT(*) FROM `$t`")->fetchColumn();
    echo str_pad($t, 22) . ": $count rows\n";
}
echo "\n=== Events ===\n";
foreach ($pdo->query("SELECT id, title_en, event_date FROM events ORDER BY event_date") as $r)
    echo "  [{$r['id']}] {$r['title_en']} — {$r['event_date']}\n";

echo "\n=== Sevas ===\n";
foreach ($pdo->query("SELECT id, name_en, amount FROM sevas WHERE is_active=1") as $r)
    echo "  [{$r['id']}] {$r['name_en']} — ₹{$r['amount']}\n";

echo "\n=== Announcements ===\n";
foreach ($pdo->query("SELECT id, title FROM announcements WHERE is_active=1") as $r)
    echo "  [{$r['id']}] {$r['title']}\n";

echo "\n=== Poojas ===\n";
foreach ($pdo->query("SELECT id, name_en, pooja_date, pooja_time FROM poojas ORDER BY pooja_date") as $r)
    echo "  [{$r['id']}] {$r['name_en']} — {$r['pooja_date']} {$r['pooja_time']}\n";

echo "\n=== Donations ===\n";
foreach ($pdo->query("SELECT id, name, amount, purpose FROM donations") as $r)
    echo "  [{$r['id']}] {$r['name']} — ₹{$r['amount']} ({$r['purpose']})\n";

echo "\n=== Sponsors ===\n";
foreach ($pdo->query("SELECT id, name, note FROM sponsors") as $r)
    echo "  [{$r['id']}] {$r['name']} — {$r['note']}\n";

echo "\nDone.\n";
