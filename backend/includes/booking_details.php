<?php
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/public_guard.php';

const BOOKING_KINDS = ['general', 'archana', 'archana_prasadam', 'archana_pooja'];
const BOOKING_DISPATCH = ['not_required', 'pending', 'dispatched', 'delivered'];

function bookingDetailsReady(): bool
{
    return publicGuardHasColumn('sevas', 'service_kind') && publicGuardHasColumn('seva_bookings', 'participants');
}

/** Shared by request bookings and gateway bookings; no client-supplied prices. */
function bookingValidateDetails(array $body, array $seva): array
{
    $fields = [];
    $participants = [];
    $delivery = in_array($seva['service_kind'] ?? '', ['archana_prasadam', 'archana_pooja'], true);
    $people = $body['participants'] ?? null;
    if (!is_array($people) || !array_is_list($people) || count($people) < 1 || count($people) > 20) {
        $fields['participants'] = 'Add between 1 and 20 people for this seva.';
    } else {
        foreach ($people as $i => $person) {
            $row = [];
            foreach (['name', 'rasi', 'nakshatram'] as $key) {
                $raw = is_array($person) ? ($person[$key] ?? null) : null;
                $value = is_string($raw) ? trim(strip_tags($raw)) : '';
                if ($value === '' || mb_strlen($value) > 100 || preg_match('/\p{Cc}/u', $value)) {
                    $fields["participants.$i.$key"] = "Enter $key using 1 to 100 characters.";
                }
                $row[$key] = $value;
            }
            $participants[] = $row;
        }
    }
    $address = null;
    if ($delivery) {
        $input = is_array($body['delivery_address'] ?? null) ? $body['delivery_address'] : [];
        $address = [];
        foreach (['address' => 500, 'city' => 120, 'state' => 120, 'postcode' => 20, 'country' => 100] as $key => $max) {
            $value = is_string($input[$key] ?? null) ? trim(strip_tags($input[$key])) : '';
            if ($value === '' || mb_strlen($value) > $max) $fields["delivery_address.$key"] = "Enter a complete delivery $key (up to $max characters).";
            $address[$key] = $value;
        }
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9 -]{1,19}$/D', $address['postcode'])) $fields['delivery_address.postcode'] = 'Enter a valid postal code.';
    }
    return ['fields' => $fields, 'values' => [
        'participants' => $participants ?: null,
        'delivery_address' => $address,
        'delivery_fee' => $delivery ? (string)$seva['delivery_fee'] : '0.00',
        'dispatch_status' => $delivery ? 'pending' : 'not_required',
    ]];
}

function bookingStoreDetails(PDO $db, int $id, array $values): void
{
    $db->prepare('UPDATE seva_bookings SET participants=?,delivery_address=?,delivery_fee=?,dispatch_status=? WHERE id=?')
        ->execute([
            $values['participants'] ? json_encode($values['participants'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : null,
            $values['delivery_address'] ? json_encode($values['delivery_address'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : null,
            $values['delivery_fee'], $values['dispatch_status'], $id,
        ]);
}
