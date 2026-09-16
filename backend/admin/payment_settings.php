<?php
// backend/admin/payment_settings.php — Payment Gateway (docs/payments/SPEC.md
// §10.4). Owners only: this page holds the keys to the temple's merchant
// account and the switch that decides whether the website takes real money.
//
// Credentials never come back out. An input shows only where a key comes from
// and its last four characters; a blank field keeps what is stored; a "Remove"
// tick clears it. A credential given in the server environment always wins and
// its field is read-only. Nothing can be stored at all without
// PAYMENTS_SETTINGS_KEY, because payment_settings holds secrets encrypted
// (sodium secretbox) and an unencrypted key in a database row is not a secret.
//
// PRODUCTION cannot be chosen until the production credentials are in place,
// PAYMENTS_SECRET is set, the return URLs are https, and the committee ticks
// that the whole lifecycle passed in TEST mode (the client requirement's §30).
// The tick is asked for once, when the mode changes to PRODUCTION; a routine
// save while already live (a message switch, a preset) keeps PRODUCTION.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/includes/admin_layout.php';

const PAY_SET_BASE = '/admin/payment_settings.php';
/** The environments whose credentials this page stores (the simulator's are fixed). */
const PAY_SET_ENVIRONMENTS = ['test' => 'TEST', 'production' => 'PRODUCTION'];
/** Credential field → [label, hint]. */
const PAY_SET_FIELD_LABELS = [
    'merchant_id'     => ['Merchant ID', 'Digits only, from the CCAvenue dashboard.'],
    'access_code'     => ['Access Code', 'Public by design: it travels in the payment form.'],
    'working_key'     => ['Working Key', 'Secret. Everything sent to CCAvenue is encrypted with it.'],
    'api_access_code' => ['API Access Code', 'Only if CCAvenue issued a separate pair for the server-to-server API.'],
    'api_working_key' => ['API Working Key', 'Only if CCAvenue issued a separate pair for the server-to-server API.'],
];

$db     = getDB();
$tables = payTablesExist();
$actor  = (string) (currentAdmin()['username'] ?? 'admin');

function paySetFlash(string $type, string $text): void
{
    $_SESSION['flash_pay_settings'] = [$type, $text];
}

/** Message for the "Test connection" answer, in the committee's words — never a raw gateway response. */
function paySetConnectionMessage(array $answer): array
{
    $code = (string) $answer['error_code'];
    if ($answer['ok'] || in_array($code, CCAV_NO_RECORD_CODES, true)) {
        return ['success', 'Connected — CCAvenue answered (it has no order called CONNECTIONTEST, which is the expected answer).'];
    }
    return match (true) {
        $answer['error'] === 'not_configured' => ['warning', 'No API credentials are set for this environment, so the status and refund API cannot be used.'],
        $answer['error'] === 'unreachable'    => ['error', 'Could not reach CCAvenue. Check the server\'s internet connection and try again.'],
        $code === '51407'                     => ['error', 'CCAvenue refused the access code, or this server\'s public IP is not whitelisted for API access.'],
        $code === '-1'                        => ['error', 'The working key does not match: CCAvenue could not read the request.'],
        default                               => ['error', ccavErrorMessage($code, 'CCAvenue refused the request.')],
    };
}

// ── POST ─────────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAdminCan('payments.settings');
    $action = (string) ($_POST['action'] ?? '');
    if (adminCsrfGuard() !== '') {
        paySetFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif (!$tables) {
        paySetFlash('error', 'Online payments are not installed yet: apply database migration 010_payments.sql first.');
    } elseif ($action === 'test_connection') {
        $env = (string) ($_POST['environment'] ?? '');
        if (!isset(payConfig()['env'][$env])) {
            paySetFlash('error', 'Choose an environment to test.');
        } else {
            $answer = ccavApi('orderStatusTracker', ['order_no' => 'CONNECTIONTEST'], payEnvConfig(payConfig(), $env));
            [$tone, $text] = paySetConnectionMessage($answer);
            paySetFlash($tone, strtoupper($env) . ': ' . $text);
            adminAudit('payment_test_connection', $env, $tone . ': ' . $text);
        }
    } elseif ($action === 'save') {
        $cfg        = payConfig();
        $keyOk      = $cfg['settings_key_ok'];
        $errors     = [];
        $changes    = [];
        $str        = static fn(string $k): string => is_scalar($_POST[$k] ?? null) ? trim((string) $_POST[$k]) : '';
        $credPosted = is_array($_POST['cred'] ?? null) ? $_POST['cred'] : [];
        $removeAsk  = is_array($_POST['remove'] ?? null) ? $_POST['remove'] : [];

        // 1. Credentials. Blank keeps what is stored; "Remove" clears it; a field
        //    supplied by the environment is never stored here.
        $effective = [];
        foreach (array_keys(PAY_SET_ENVIRONMENTS) as $env) {
            $status = payCredentialStatus($env);
            foreach (PAY_CREDENTIAL_FIELDS as $field) {
                $key     = PAY_CREDENTIAL_PREFIX[$env] . $field;
                $current = $status[$field];
                $posted  = is_scalar($credPosted[$env][$field] ?? null) ? trim((string) $credPosted[$env][$field]) : '';
                $remove  = !empty($removeAsk[$env][$field]);
                $effective[$env][$field] = $current['source'] === 'env' ? payCredential($env, $field) : ($current['source'] === 'stored' ? (payStoredSecret($key) ?? '') : '');
                if ($current['source'] === 'env') continue;
                if ($remove) {
                    $changes[$key] = null;
                    $effective[$env][$field] = '';
                    continue;
                }
                if ($posted === '') continue;
                if (!$keyOk) {
                    $errors[] = 'Gateway keys cannot be stored until PAYMENTS_SETTINGS_KEY is set on the server.';
                    continue;
                }
                if ($field === 'merchant_id' && !preg_match('/^\d{1,20}$/D', $posted)) {
                    $errors[] = strtoupper($env) . ' Merchant ID must be digits only.';
                    continue;
                }
                if (mb_strlen($posted) > 200 || preg_match('/[\x00-\x1F\x7F]/', $posted)) {
                    $errors[] = strtoupper($env) . ' ' . PAY_SET_FIELD_LABELS[$field][0] . ' is not a valid key.';
                    continue;
                }
                $changes[$key] = $posted;
                $effective[$env][$field] = $posted;
            }
        }

        // 2. Currencies.
        $posted = is_array($_POST['currencies'] ?? null) ? $_POST['currencies'] : [];
        $list   = ['INR'];
        foreach ($posted as $code) {
            $code = is_scalar($code) ? strtoupper(trim((string) $code)) : '';
            if (isset(PAY_SUPPORTED_CURRENCIES[$code]) && !in_array($code, $list, true)) $list[] = $code;
        }
        $changes['currencies'] = implode(',', $list);
        $default = strtoupper($str('default_currency'));
        if (!in_array($default, $list, true)) {
            if ($default !== '' && $default !== 'INR') $errors[] = 'The default currency must be one of the currencies you accept.';
            $default = 'INR';
        }
        $changes['default_currency']      = $default;
        $changes['international_enabled'] = isset($_POST['international_enabled']) ? '1' : '0';

        // 3. Amounts.
        $min = payAmountParse($str('donation_min'));
        $max = payAmountParse($str('donation_max'));
        $maxForeign = payAmountParse($str('donation_max_foreign'));
        if ($min === null || payAmountCents($min) < 100) {
            $errors[] = 'The smallest donation must be at least ₹1.';
            $min = $cfg['donation_min'];
        }
        if ($max === null || payAmountCents($max) < payAmountCents($min)) {
            $errors[] = 'The largest donation must be at least as much as the smallest.';
            $max = $cfg['donation_max'];
        }
        if ($maxForeign === null || payAmountCents($maxForeign) < 100 || payAmountCents($maxForeign) % 100 !== 0) {
            $errors[] = 'The largest foreign-currency donation must be a whole number of at least 1.';
            $maxForeign = $cfg['donation_max_foreign'];
        }
        $changes['donation_min']         = $min;
        $changes['donation_max']         = $max;
        $changes['donation_max_foreign'] = $maxForeign;

        $presets = [];
        foreach (explode(',', $str('preset_amounts')) as $p) {
            $p = trim($p);
            if ($p === '') continue;
            if (!ctype_digit($p) || strlen($p) > 10) {
                $errors[] = 'Suggested amounts must be whole rupee numbers separated by commas.';
                $presets = [];
                break;
            }
            $cents = (int) $p * 100;
            if ($cents < payAmountCents($min) || $cents > payAmountCents($max)) {
                $errors[] = 'Each suggested amount must be between the smallest and the largest donation.';
                $presets = [];
                break;
            }
            if (!in_array((int) $p, $presets, true)) $presets[] = (int) $p;
        }
        if (count($presets) > 6) {
            $errors[] = 'Give at most six suggested amounts.';
            $presets = array_slice($presets, 0, 6);
        }
        if ($presets) $changes['preset_amounts'] = implode(',', $presets);

        // 4. Receipts, messages and sevas.
        $prefix = strtoupper($str('receipt_prefix'));
        if (!preg_match('/^[A-Z]{2,8}$/D', $prefix)) {
            $errors[] = 'The receipt prefix must be 2 to 8 letters (A–Z).';
        } else {
            $changes['receipt_prefix'] = $prefix;
        }
        foreach (['notify_email', 'notify_sms', 'notify_whatsapp', 'seva_online_enabled'] as $flag) {
            $changes[$flag] = isset($_POST[$flag]) ? '1' : '0';
        }
        $hold = $str('hold_minutes');
        if (!ctype_digit($hold) || (int) $hold < 10 || (int) $hold > 1440) {
            $errors[] = 'The seva hold must be between 10 and 1440 minutes.';
        } else {
            $changes['hold_minutes'] = (string) (int) $hold;
        }

        // 5. Mode and the master switch — checked against what will be in force
        //    after this save, not what was in force before it.
        $mode = $str('mode');
        if (!in_array($mode, PAY_MODES, true)) $mode = $cfg['mode'];
        if ($mode === 'simulator' && !$cfg['simulator_allowed']) {
            $errors[] = 'SIMULATOR mode is only for development servers (PAYMENTS_ALLOW_SIMULATOR=1).';
            $mode = $cfg['mode'] === 'simulator' ? 'test' : $cfg['mode'];
        }
        if ($mode === 'production') {
            $prod = $effective['production'];
            if (!ctype_digit($prod['merchant_id']) || $prod['access_code'] === '' || $prod['working_key'] === '') {
                $errors[] = 'PRODUCTION needs a Merchant ID, an Access Code and a Working Key before it can be chosen.';
                $mode = $cfg['mode'] === 'production' ? 'test' : $cfg['mode'];
            } elseif (!$cfg['secret_ok']) {
                $errors[] = 'PRODUCTION needs PAYMENTS_SECRET (at least 32 characters) in the server environment.';
                $mode = $cfg['mode'] === 'production' ? 'test' : $cfg['mode'];
            } elseif (($urlProblem = payUrlProblem($cfg['redirect_url'], 'production')) !== '') {
                $errors[] = $urlProblem;
                $mode = $cfg['mode'] === 'production' ? 'test' : $cfg['mode'];
            } elseif ($cfg['mode'] !== 'production' && ($_POST['tested_in_test'] ?? '') !== '1') {
                // Only the switch to PRODUCTION needs the tick; once live, a save without it stays live.
                $errors[] = 'Tick “the full payment lifecycle has passed testing in TEST mode” before going live.';
                $mode = $cfg['mode'];
            }
        }
        $changes['mode']    = $mode;
        $changes['enabled'] = isset($_POST['enabled']) ? '1' : '0';

        try {
            $changed = paySettingsSaveMany($db, $changes, $actor);
            payConfigReset();
            if ($changed) adminAudit('payment_settings', 'payment gateway', 'changed: ' . implode(', ', $changed));
            $saved = $changed ? count($changed) . ' setting' . (count($changed) === 1 ? '' : 's') . ' saved.' : 'Nothing changed.';
            if ($errors) {
                paySetFlash('warning', $saved . ' Not everything could be applied: ' . implode(' ', array_unique($errors)));
            } else {
                paySetFlash('success', $saved);
            }
        } catch (Throwable $e) {
            error_log('[payments] settings save failed: ' . get_class($e) . ': ' . $e->getMessage());
            paySetFlash('error', 'The settings could not be saved. Nothing was changed.');
        }
    } else {
        paySetFlash('error', 'That action is not available on this page.');
    }
    header('Location: ' . PAY_SET_BASE, true, 303);
    exit;
}

// ── Page ─────────────────────────────────────────────────────────────────────
$msg = '';
if (!empty($_SESSION['flash_pay_settings'])) {
    [$fType, $fText] = $_SESSION['flash_pay_settings'];
    unset($_SESSION['flash_pay_settings']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}

adminHeader('Payment Gateway', 'Data & System', [
    'actions' => '<a href="/admin/payments.php" class="btn btn-ghost btn--sm">' . adminIcon('landmark') . 'Online Payments</a>',
]);
echo $msg;

if (!$tables) {
    echo adminEmpty(
        'shield',
        'Online payments are not installed yet',
        'Apply database migration 010_payments.sql (see README), then come back to switch CCAvenue on.'
    );
    adminFooter();
    exit;
}

$cfg      = payConfig();
$ready    = payReady();
$mode     = $cfg['mode'];
$env      = payEnvConfig($cfg, $mode);
$apiOk    = ccavApiConfigured($mode);
$keyOk    = $cfg['settings_key_ok'];
$statuses = ['test' => payCredentialStatus('test'), 'production' => payCredentialStatus('production')];

$statusHeadline = match (true) {
    $ready['ok'] && $mode === 'production' => 'Online payments are live in PRODUCTION — real money is taken.',
    $ready['ok'] && $mode === 'test'       => 'Online payments are running in TEST mode. CCAvenue test cards only; no real money moves.',
    $ready['ok']                           => 'Online payments are running in SIMULATOR mode. Nothing leaves this server and no money moves.',
    !$cfg['enabled']                       => 'Online payments are off. Devotees see the pledge form and the bank details instead.',
    default                                => $ready['reason'],
};
$statusTone = $ready['ok'] ? ($mode === 'production' ? 'success' : 'warning') : 'muted';

echo adminPageIntro(
    'How the website takes money: which CCAvenue account it talks to, which currencies and amounts it accepts, and which messages a payment sends. Only owners can open this page.',
    adminBadge(strtoupper($mode), $statusTone) . ' ' . adminBadge($cfg['enabled'] ? 'Switched on' : 'Switched off', $cfg['enabled'] ? 'success' : 'muted')
);
?>

<section class="card card--static" aria-labelledby="pay-status-title">
  <div class="card__head">
    <h2 id="pay-status-title"><?= adminIcon('activity', 'ico--sm') ?> Status</h2>
    <?= adminBadge($ready['ok'] ? 'Ready' : 'Not taking payments', $ready['ok'] ? 'success' : 'warning') ?>
  </div>
  <div class="card__body">
    <p class="<?= $ready['ok'] ? 'muted' : 'alert alert--warning' ?>"<?= $ready['ok'] ? '' : ' role="status"' ?>><?= h($statusHeadline) ?></p>
    <dl class="dl-grid">
      <dt>Mode</dt><dd><?= adminBadge(strtoupper($mode), $statusTone) ?></dd>
      <dt>Checkout page</dt><dd><span class="pay-url"><?= h($env['transaction_url']) ?></span></dd>
      <dt>Status &amp; refund API</dt>
      <dd><?= $apiOk ? adminBadge('Configured', 'success') : adminBadge('Not configured', 'muted') ?>
          <span class="field__hint"><?= $apiOk ? 'Payments are confirmed server-to-server and refunds can be sent from here.' : 'Without it, a payment is trusted on CCAvenue\'s browser response alone and refunds must be recorded by hand.' ?></span></dd>
      <dt>PAYMENTS_SECRET</dt>
      <dd><?= $cfg['secret_ok'] ? adminBadge('Set', 'success') : adminBadge('Not set', 'warning') ?>
          <span class="field__hint">Signs the links in receipts and messages. Required for PRODUCTION.</span></dd>
      <dt>PAYMENTS_SETTINGS_KEY</dt>
      <dd><?= $keyOk ? adminBadge('Set', 'success') : adminBadge('Not set', 'warning') ?>
          <span class="field__hint"><?= $keyOk ? 'Gateway keys typed below are stored encrypted.' : 'Without it, keys can only come from the server environment.' ?></span></dd>
      <dt>Simulator</dt>
      <dd><?= $cfg['simulator_allowed'] ? adminBadge('Allowed on this server', 'danger') : adminBadge('Not allowed', 'muted') ?></dd>
    </dl>
  </div>
</section>

<form method="POST" action="<?= PAY_SET_BASE ?>" class="pay-settings mt-6">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="save" />

  <section class="card card--static" aria-labelledby="pay-mode-title">
    <div class="card__head"><h2 id="pay-mode-title"><?= adminIcon('toggle', 'ico--sm') ?> Mode</h2></div>
    <div class="card__body">
      <div class="settings-list">
        <div class="settings-row">
          <div class="settings-row__text">
            <strong id="enabled-title">Take payments online</strong>
            <span id="enabled-desc">When this is off, /donate offers the pledge form and the bank details only.</span>
          </div>
          <label class="switch">
            <input type="checkbox" role="switch" name="enabled" value="1"<?= $cfg['enabled'] ? ' checked' : '' ?>
                   aria-labelledby="enabled-title" aria-describedby="enabled-desc" />
            <span class="switch__track" aria-hidden="true"></span>
          </label>
        </div>
      </div>

      <fieldset class="mt-4">
        <legend class="field__label">Which CCAvenue account</legend>
        <label class="choice">
          <input type="radio" name="mode" value="test"<?= $mode === 'test' ? ' checked' : '' ?> />
          <span><strong>TEST</strong><span class="field__hint">CCAvenue's sandbox. Test cards only; no real money.</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="mode" value="production"<?= $mode === 'production' ? ' checked' : '' ?> />
          <span><strong>PRODUCTION</strong><span class="field__hint">Real money from real devotees.</span></span>
        </label>
        <?php if ($cfg['simulator_allowed']): ?>
        <label class="choice">
          <input type="radio" name="mode" value="simulator"<?= $mode === 'simulator' ? ' checked' : '' ?> />
          <span><strong>SIMULATOR</strong><span class="field__hint">Development only. A fake gateway on this server; nothing reaches CCAvenue.</span></span>
        </label>
        <?php endif; ?>
      </fieldset>

      <label class="switch mt-4">
        <input type="checkbox" name="tested_in_test" value="1" />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>The full payment lifecycle has passed testing in TEST mode</strong>
          <span class="switch__desc">Payment, failure, cancellation, duplicate response, receipt, message and refund — all tried with CCAvenue's test instruments. Needed once, when switching to PRODUCTION; later saves while live do not ask again.</span></span>
      </label>
    </div>
  </section>

  <section class="card card--static mt-6" aria-labelledby="pay-cred-title">
    <div class="card__head">
      <h2 id="pay-cred-title"><?= adminIcon('key', 'ico--sm') ?> Credentials</h2>
      <?= $keyOk ? adminBadge('Stored encrypted', 'success') : adminBadge('Read-only: no settings key', 'warning') ?>
    </div>
    <div class="card__body">
      <?php if (!$keyOk): ?>
        <p class="alert alert--warning" role="status" data-keep>Set <code>PAYMENTS_SETTINGS_KEY</code> to store keys here, or put them in the environment.
          Generate one with <code>php -r "echo base64_encode(random_bytes(32));"</code> and add it to the hosting panel.</p>
      <?php endif; ?>
      <?php foreach (PAY_SET_ENVIRONMENTS as $envName => $envLabel): ?>
      <fieldset class="pay-cred">
        <legend class="field__label"><?= h($envLabel) ?></legend>
        <?php foreach (PAY_SET_FIELD_LABELS as $field => [$label, $hint]):
            $s       = $statuses[$envName][$field];
            $id      = "cred-{$envName}-{$field}";
            $fromEnv = $s['source'] === 'env';
            $locked  = $fromEnv || !$keyOk;
            $place   = match ($s['source']) {
                'env'        => 'Set in the server environment (' . $s['env'] . ')',
                'stored'     => '•••• ' . $s['last4'] . ' (stored)',
                'unreadable' => 'Stored, but it cannot be read with this PAYMENTS_SETTINGS_KEY',
                default      => 'Not set',
            };
        ?>
        <div class="pay-cred__row">
          <label for="<?= h($id) ?>">
            <span class="field__label"><?= h($label) ?></span>
            <span class="field-with-button">
              <input id="<?= h($id) ?>" type="password" name="cred[<?= h($envName) ?>][<?= h($field) ?>]"
                     autocomplete="off" spellcheck="false" maxlength="200" placeholder="<?= h($place) ?>"<?= $locked ? ' disabled' : '' ?> />
              <?php if (!$locked): ?>
                <button type="button" class="btn btn-ghost btn--icon btn--sm" data-toggle-password="<?= h($id) ?>" aria-pressed="false" aria-label="Show <?= h($label) ?>"><?= adminIcon('eye') ?></button>
              <?php endif; ?>
            </span>
            <span class="field__hint"><?= h($hint) ?> <?= $fromEnv ? 'This one comes from the server environment and cannot be changed here.' : 'Leave blank to keep what is stored.' ?></span>
          </label>
          <?php if (!$fromEnv && in_array($s['source'], ['stored', 'unreadable'], true)): ?>
            <label class="pay-cred__remove" for="rm-<?= h($id) ?>">
              <input id="rm-<?= h($id) ?>" type="checkbox" name="remove[<?= h($envName) ?>][<?= h($field) ?>]" value="1" />
              <span>Remove</span>
            </label>
          <?php endif; ?>
        </div>
        <?php endforeach; ?>
        <div class="cluster">
          <button type="submit" form="test-<?= h($envName) ?>" class="btn btn--sm"><?= adminIcon('flask') ?> Test <?= h($envLabel) ?> connection</button>
          <span class="field__hint">Asks CCAvenue about an order that does not exist. A polite refusal means the keys and the IP whitelist are right.</span>
        </div>
      </fieldset>
      <?php endforeach; ?>
    </div>
  </section>

  <section class="card card--static mt-6" aria-labelledby="pay-urls-title">
    <div class="card__head"><h2 id="pay-urls-title"><?= adminIcon('globe', 'ico--sm') ?> Values for the CCAvenue dashboard</h2></div>
    <div class="card__body">
      <p class="muted">Register these three addresses in the CCAvenue merchant dashboard for each environment you use.</p>
      <?php foreach ([
          ['Redirect URL', 'url-redirect', $cfg['redirect_url'], 'Where CCAvenue sends the devotee after a payment.'],
          ['Cancel URL', 'url-cancel', $cfg['cancel_url'], 'Where CCAvenue sends the devotee if they abandon the payment.'],
          ['Notification (DEN) URL', 'url-notify', $cfg['notify_url'], 'Server-to-server copy of the result, in case the browser never comes back.'],
      ] as [$label, $id, $value, $hint]): $problem = payUrlProblem($value, $mode); ?>
        <label for="<?= h($id) ?>">
          <span class="field__label"><?= h($label) ?></span>
          <input id="<?= h($id) ?>" type="text" value="<?= h($value) ?>" readonly aria-readonly="true" />
          <span class="field__hint"><?= h($hint) ?></span>
          <?php if ($problem !== ''): ?><span class="field__error"><?= adminIcon('alert-circle') ?><?= h($problem) ?></span><?php endif; ?>
        </label>
      <?php endforeach; ?>
      <p class="callout"><?= adminIcon('info') ?> Ask CCAvenue to whitelist this server's public IP for API access, or the status and refund calls are refused with error 51407.
        <?php $serverIp = (string) ($_SERVER['SERVER_ADDR'] ?? ''); if ($serverIp !== ''): ?>
          This server reports its own address as <span class="tabular"><?= h($serverIp) ?></span>; the hosting provider's outbound address may differ, so confirm it with them.
        <?php endif; ?>
      </p>
    </div>
  </section>

  <div class="dash-grid mt-6">
    <section class="card card--static" aria-labelledby="pay-cur-title">
      <div class="card__head"><h2 id="pay-cur-title"><?= adminIcon('banknote', 'ico--sm') ?> Currencies</h2></div>
      <div class="card__body">
        <fieldset>
          <legend class="field__label">Currencies CCAvenue has activated for this account</legend>
          <div class="pay-currencies">
            <?php foreach (paySupportedCurrencies() as $code => $meta): $on = in_array($code, $cfg['currencies_setting'], true); ?>
              <label class="choice" for="cur-<?= h($code) ?>">
                <input id="cur-<?= h($code) ?>" type="checkbox" name="currencies[]" value="<?= h($code) ?>"<?= $on || $code === 'INR' ? ' checked' : '' ?><?= $code === 'INR' ? ' disabled' : '' ?> />
                <span><?= h($code) ?> <span class="field__hint"><?= h($meta['name']) ?><?= $meta['decimals'] === 0 ? ' · whole amounts only' : '' ?></span></span>
              </label>
            <?php endforeach; ?>
          </div>
          <span class="field__hint">INR is always accepted.</span>
        </fieldset>
        <label for="default_currency">
          <span class="field__label">Default currency</span>
          <select id="default_currency" name="default_currency">
            <?php foreach ($cfg['currencies_setting'] as $code): ?>
              <option value="<?= h($code) ?>"<?= $cfg['default_currency'] === $code ? ' selected' : '' ?>><?= h($code) ?> — <?= h(PAY_SUPPORTED_CURRENCIES[$code]['name']) ?></option>
            <?php endforeach; ?>
          </select>
        </label>
        <label class="switch">
          <input type="checkbox" name="international_enabled" value="1"<?= $cfg['international'] ? ' checked' : '' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong>Accept international payments</strong>
            <span class="switch__desc">Turn on only after CCAvenue has activated international cards and these currencies for your merchant account. While it is off, only INR is offered — devotees abroad can still give in INR.</span></span>
        </label>
      </div>
    </section>

    <section class="card card--static" aria-labelledby="pay-amt-title">
      <div class="card__head"><h2 id="pay-amt-title"><?= adminIcon('trending', 'ico--sm') ?> Amounts</h2></div>
      <div class="card__body">
        <div class="form-grid">
          <label for="donation_min">
            <span class="field__label">Smallest donation (₹)</span>
            <input id="donation_min" type="text" inputmode="decimal" name="donation_min" value="<?= h($cfg['donation_min']) ?>" maxlength="13" />
          </label>
          <label for="donation_max">
            <span class="field__label">Largest donation (₹)</span>
            <input id="donation_max" type="text" inputmode="decimal" name="donation_max" value="<?= h($cfg['donation_max']) ?>" maxlength="13" />
          </label>
        </div>
        <label for="donation_max_foreign">
          <span class="field__label">Largest donation in a foreign currency</span>
          <input id="donation_max_foreign" type="text" inputmode="decimal" name="donation_max_foreign" value="<?= h($cfg['donation_max_foreign']) ?>" maxlength="13" />
          <span class="field__hint">Whole units of whichever currency the donor chooses.</span>
        </label>
        <label for="preset_amounts">
          <span class="field__label">Suggested amounts (₹)</span>
          <input id="preset_amounts" type="text" name="preset_amounts" value="<?= h(implode(',', $cfg['presets'])) ?>" maxlength="80" autocomplete="off" />
          <span class="field__hint">Up to six whole numbers separated by commas; they become the chips on the donation form.</span>
        </label>
      </div>
    </section>
  </div>

  <div class="dash-grid mt-6">
    <section class="card card--static" aria-labelledby="pay-msg-title">
      <div class="card__head"><h2 id="pay-msg-title"><?= adminIcon('mail', 'ico--sm') ?> Receipts &amp; messages</h2></div>
      <div class="card__body">
        <label for="receipt_prefix">
          <span class="field__label">Receipt prefix</span>
          <input id="receipt_prefix" type="text" name="receipt_prefix" value="<?= h($cfg['receipt_prefix']) ?>" maxlength="8" pattern="[A-Za-z]{2,8}" autocomplete="off" />
          <span class="field__hint">2–8 letters. Receipts are numbered <?= h($cfg['receipt_prefix']) ?>-<?= h(payIstDate(null, 'Y')) ?>-000001 and never repeat.</span>
        </label>
        <div class="settings-list">
          <?php
          $notifyReady = function_exists('devoteeNotifyReady') && devoteeNotifyReady();
          foreach ([
              ['notify_email', 'email', 'Email', 'The receipt and its link; the only channel that carries the details table.', $cfg['notify_email']],
              ['notify_whatsapp', 'whatsapp', 'WhatsApp', 'A short thank-you with a button to the receipt.', $cfg['notify_whatsapp']],
              ['notify_sms', 'sms', 'SMS', 'A short thank-you. Each message is charged by the provider.', $cfg['notify_sms']],
          ] as [$key, $channel, $label, $desc, $on]):
              $provider = notifyProviderFor($channel);
              $readyLine = !$notifyReady
                  ? 'The notification service is not installed, so nothing can be sent.'
                  : $label . ' provider: ' . $provider->name() . ($provider->isConfigured() ? ' — ready.' : ' — not configured, messages will be skipped.');
          ?>
            <div class="settings-row">
              <div class="settings-row__text">
                <strong id="<?= h($key) ?>-title"><?= h($label) ?></strong>
                <span id="<?= h($key) ?>-desc"><?= h($desc) ?> <?= h($readyLine) ?></span>
              </div>
              <label class="switch">
                <input type="checkbox" role="switch" name="<?= h($key) ?>" value="1"<?= $on ? ' checked' : '' ?>
                       aria-labelledby="<?= h($key) ?>-title" aria-describedby="<?= h($key) ?>-desc" />
                <span class="switch__track" aria-hidden="true"></span>
              </label>
            </div>
          <?php endforeach; ?>
        </div>
      </div>
    </section>

    <section class="card card--static" aria-labelledby="pay-seva-title">
      <div class="card__head"><h2 id="pay-seva-title"><?= adminIcon('sparkles', 'ico--sm') ?> Seva payments</h2></div>
      <div class="card__body">
        <label class="switch">
          <input type="checkbox" name="seva_online_enabled" value="1"<?= $cfg['seva_online'] ? ' checked' : '' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong>Allow paying for sevas online</strong>
            <span class="switch__desc">Devotees can pay a seva's price on the website. The office still confirms the date by phone, so a paid booking stays “pending”.</span></span>
        </label>
        <label for="hold_minutes">
          <span class="field__label">Hold an unpaid booking for (minutes)</span>
          <input id="hold_minutes" type="number" name="hold_minutes" value="<?= (int) $cfg['hold_minutes'] ?>" min="10" max="1440" step="1" inputmode="numeric" />
          <span class="field__hint">Between 10 and 1440. An online booking that is never paid is cancelled after this.</span>
        </label>
      </div>
    </section>
  </div>

  <div class="form-actions mt-6">
    <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save payment settings</button>
  </div>
</form>

<?php foreach (array_keys(PAY_SET_ENVIRONMENTS) as $envName): ?>
<form method="POST" action="<?= PAY_SET_BASE ?>" id="test-<?= h($envName) ?>" class="sr-only">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="test_connection" />
  <input type="hidden" name="environment" value="<?= h($envName) ?>" />
</form>
<?php endforeach; ?>

<?php adminFooter(); ?>
