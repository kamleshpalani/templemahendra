<?php
require_once __DIR__ . '/../includes/registration.php';
header('Cache-Control: no-store');
if (!publicGuardHasColumn('matrimony_profiles', 'management_hash')) sendError('Matrimony registration is not available yet.', 503);
$db = getDB();
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Only explicitly consented, moderated summaries. Never names, birth dates or contact details.
    $rows = $db->query("SELECT id, TIMESTAMPDIFF(YEAR,date_of_birth,CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30')) AS age,
        city,education,occupation,introduction,preferences
        FROM matrimony_profiles WHERE status='approved' AND visibility='public_summary'
        ORDER BY created_at DESC LIMIT 50")->fetchAll();
    sendJson($rows);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') sendError('Method not allowed', 405);
publicGuardLimit('matrimony-attempt');
$body = getJsonBody();
$action = is_string($body['action'] ?? null) ? $body['action'] : 'create';
if (!in_array($action, ['create','load','update','delete'], true)) sendError('Unknown profile action.', 422);
$profile = null;
if ($action !== 'create') {
    publicGuardLimit('matrimony-management');
    $token = is_string($body['management_token'] ?? null) ? $body['management_token'] : '';
    if (!preg_match('/^[a-f0-9]{64}$/D', $token)) sendError('The management key is invalid.', 403);
    $stmt = $db->prepare('SELECT * FROM matrimony_profiles WHERE management_hash=?');
    $stmt->execute([hash('sha256', $token)]);
    $profile = $stmt->fetch();
    if (!$profile) sendError('The management key is invalid.', 403);
    if ($action === 'delete') {
        $db->prepare('DELETE FROM matrimony_profiles WHERE id=?')->execute([$profile['id']]);
        sendJson(['success'=>true]);
    }
    if ($action === 'load') {
        unset($profile['management_hash']);
        sendJson(['profile'=>$profile]);
    }
}
publicGuardHoneypotOrContinue($body);
$errors = [];
$values = [];
foreach (['name'=>[2,200], 'city'=>[2,120], 'education'=>[0,200], 'occupation'=>[0,200],
    'rasi'=>[0,100], 'nakshatram'=>[0,100], 'introduction'=>[0,1000], 'preferences'=>[0,1000], 'email'=>[0,190]] as $key=>[$min,$max]) {
    [$value,$ok] = registrationText($body,$key);
    if (!$ok || mb_strlen($value)<$min || mb_strlen($value)>$max) $errors[$key] = "Enter $key using $min to $max characters.";
    $values[$key] = $value;
}
[$dob,$problem] = registrationDateOfBirth($body);
if ($problem !== '' || $dob === null || registrationAgeFrom($dob) < 18) $errors['dateOfBirth'] = 'Matrimony registration is for adults aged 18 or over.';
$values['date_of_birth'] = $dob;
$ph = normalizePhone(is_string($body['phone'] ?? null) ? $body['phone'] : '', is_string($body['phoneCountry'] ?? null) ? $body['phoneCountry'] : null, true);
if ($ph['error'] !== '') $errors['phone'] = $ph['error'];
$values['phone'] = $ph['phone'];
$values['phone_country'] = $ph['country'];
if ($values['email'] !== '' && !filter_var($values['email'],FILTER_VALIDATE_EMAIL)) $errors['email']='Enter a valid email, or leave it blank.';
if (!publicGuardConsent($body['consent'] ?? null)) $errors['consent']='Confirm that this is your profile and you consent to private committee review.';
$visibility = $body['visibility'] ?? null;
if (!in_array($visibility,['private','public_summary'],true)) $errors['visibility']='Choose a privacy setting.';
$values['visibility'] = $visibility;
if ($errors) sendJson(['error'=>REG_FIELDS_ERROR,'fields'=>$errors],422);
if ($action === 'create') publicGuardLimit('matrimony-saved');
$values['reuse_consent_at'] = publicGuardConsent($body['reuseConsent'] ?? null) ? gmdate('Y-m-d H:i:s') : null;
if ($profile) {
    $sets = implode(',',array_map(static fn($key)=>"$key=:$key",array_keys($values)));
    $db->prepare("UPDATE matrimony_profiles SET $sets,status='pending',consent_at=UTC_TIMESTAMP() WHERE id=:id")->execute($values+['id'=>$profile['id']]);
    sendJson(['success'=>true,'id'=>(int)$profile['id'],'status'=>'pending']);
}
$token = bin2hex(random_bytes(32));
$values['management_hash'] = hash('sha256',$token);
$columns = implode(',',array_keys($values));
$params = implode(',',array_map(static fn($key)=>":$key",array_keys($values)));
$db->prepare("INSERT INTO matrimony_profiles ($columns,consent_at) VALUES ($params,UTC_TIMESTAMP())")->execute($values);
sendJson(['success'=>true,'id'=>(int)$db->lastInsertId(),'status'=>'pending','management_token'=>$token],201);
