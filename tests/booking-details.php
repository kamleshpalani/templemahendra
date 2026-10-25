<?php
require_once __DIR__ . '/../backend/includes/booking_details.php';

$checks = 0;
function checkDetails(bool $condition, string $message): void
{
    global $checks;
    if (!$condition) throw new RuntimeException($message);
    $checks++;
}

$person = ['name' => 'Devotee', 'rasi' => 'Mesham', 'nakshatram' => 'Ashwini'];
foreach (BOOKING_KINDS as $kind) {
    $seva = ['service_kind' => $kind, 'delivery_fee' => '50.00'];
    $body = ['participants' => [$person], 'delivery_address' => [
        'address' => '1 Temple Street', 'city' => 'Tenkasi', 'state' => 'Tamil Nadu',
        'country' => 'India', 'postcode' => '627719',
    ]];
    $valid = bookingValidateDetails($body, $seva);
    checkDetails(!$valid['fields'], "$kind accepts complete details");
    checkDetails($valid['values']['participants'] === [$person], "$kind preserves participants");
    foreach (['name', 'rasi', 'nakshatram'] as $key) {
        $invalid = $body;
        unset($invalid['participants'][0][$key]);
        checkDetails(isset(bookingValidateDetails($invalid, $seva)['fields']["participants.0.$key"]), "$kind requires $key");
    }
    foreach ([null, [], array_fill(0, 21, $person)] as $people) {
        checkDetails(isset(bookingValidateDetails(['participants' => $people], $seva)['fields']['participants']), "$kind rejects invalid participant count");
    }
    $body['participants'][] = $person;
    checkDetails(count(bookingValidateDetails($body, $seva)['values']['participants']) === 2, "$kind accepts multiple people");
    $delivery = in_array($kind, ['archana_prasadam', 'archana_pooja'], true);
    checkDetails($valid['values']['delivery_fee'] === ($delivery ? '50.00' : '0.00'), "$kind preserves delivery pricing");
}
echo "PASS $checks booking detail checks\n";
