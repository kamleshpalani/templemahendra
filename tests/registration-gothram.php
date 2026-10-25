<?php
require_once __DIR__ . '/../backend/includes/registration.php';

$checks = 0;
function checkGothram(bool $ok, string $message): void
{
    global $checks;
    $checks++;
    if (!$ok) throw new RuntimeException($message);
}

$member = ['name' => 'QA Gothram Member', 'relationship' => 'son', 'gothram' => '  காசியப  '];
$checked = registrationValidateMember($member, 'members.0');
checkGothram($checked['errors'] === [], 'Tamil Gothram accepted');
checkGothram($checked['values']['gothram'] === 'காசியப', 'Gothram trimmed');
foreach ([null, '', '   '] as $blank) {
    $result = registrationValidateMember(array_replace($member, ['gothram' => $blank]), 'members.0');
    checkGothram($result['values']['gothram'] === null && !$result['errors'], 'Optional Gothram');
}
foreach ([str_repeat('க', 101), ['invalid'], 123, true] as $invalid) {
    $result = registrationValidateMember(array_replace($member, ['gothram' => $invalid]), 'members.0');
    checkGothram(isset($result['errors']['members.0.gothram']), 'Invalid Gothram rejected');
}
$boundary = registrationValidateMember(array_replace($member, ['gothram' => str_repeat('க', 100)]), 'members.0');
checkGothram($boundary['errors'] === [], '100-character boundary accepted');

$db = getDB();
$db->beginTransaction();
try {
    $input = [
        'name' => 'QA Gothram Transaction', 'phone' => '+919443000001', 'phoneCountry' => 'IN',
        'country' => 'IN', 'address1' => '10 Test Street', 'city' => 'Tenkasi', 'state' => 'Tamil Nadu',
        'postcode' => '627719', 'lang' => 'en', 'members' => [$member], 'consent' => false,
    ];
    $valid = registrationValidate($input);
    checkGothram($valid['errors'] === [], 'Registration validates');
    // registrationCreate owns a transaction; use a scoped fixture parent instead.
    $db->exec("INSERT INTO devotees (name, phone, lang, is_active) VALUES ('QA Gothram Transaction', '+919443000001', 'en', 1)");
    $id = (int)$db->lastInsertId();
    registrationApplyMembers($db, $id, [['id' => 0] + $checked['values']], []);
    $saved = registrationMembers($db, $id);
    checkGothram($saved[0]['gothram'] === 'காசியப', 'Gothram persisted to MySQL');
    $edited = registrationValidateMemberRows([['id' => (string)$saved[0]['id']] + array_replace($member, ['gothram' => 'Bharadwaja'])]);
    checkGothram($edited['errors'] === [], 'Admin member row validates');
    registrationApplyMembers($db, $id, $edited['keep'], []);
    checkGothram(registrationMembers($db, $id)[0]['gothram'] === 'Bharadwaja', 'Admin edit persists Gothram');
    $cleared = registrationValidateMemberRows([['id' => (string)$saved[0]['id']] + array_replace($member, ['gothram' => ''])]);
    registrationApplyMembers($db, $id, $cleared['keep'], []);
    checkGothram(registrationMembers($db, $id)[0]['gothram'] === null, 'Gothram can be cleared');
} finally {
    $db->rollBack();
}
$createdId = registrationCreate($db, $valid['values']);
try {
    checkGothram(registrationMembers($db, $createdId)[0]['gothram'] === 'காசியப', 'Public registration persists Gothram');
} finally {
    $cleanup = $db->prepare('DELETE FROM devotees WHERE id = ? AND name = ?');
    $cleanup->execute([$createdId, 'QA Gothram Transaction']);
}
echo "$checks Gothram checks passed (owned fixtures cleaned)\n";
