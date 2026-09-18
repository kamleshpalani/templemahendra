<?php
// backend/admin/live_settings.php — YouTube Automation (docs/live/SPEC-PHASE3.md
// §8.3). Owners only: this page holds the keys to the temple's YouTube channel
// and the switch that lets the scheduled job move a stream's status by itself.
//
// Built on payment_settings.php, with the same contract: credentials never come
// back out. An input shows only where a key comes from and its last four
// characters; a blank field keeps what is stored; a "Remove" tick clears it. A
// credential given in the server environment always wins and its field is
// read-only. Nothing can be stored at all without LIVE_SETTINGS_KEY, because
// live_settings holds secrets encrypted (sodium secretbox) and an unencrypted
// key in a database row is not a secret.
//
// Live mode cannot be chosen until a credential is in place; the reason comes
// from liveAutomationReady(). The Simulator radio exists only on a server that
// allows the YouTube stand-in (LIVE_ALLOW_SIMULATOR=1).
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/live.php';
require_once __DIR__ . '/../includes/rate_limit.php';
require_once __DIR__ . '/includes/admin_layout.php';

const LIVE_SET_BASE = '/admin/live_settings.php';
/** Credential field → [label, hint]. */
const LIVE_SET_FIELD_LABELS = [
    'api_key'       => ['API key', 'From Google Cloud → Credentials, with the YouTube Data API v3 enabled. Enough to read public broadcast data (Tier 1).'],
    'client_id'     => ['OAuth client ID', 'The web/desktop OAuth client of the same Google Cloud project. Needed with the client secret and a refresh token for owner-only broadcast data (Tier 2).'],
    'client_secret' => ['OAuth client secret', 'Secret. Rotating it in Google Cloud means saving it here again.'],
    'refresh_token' => ['OAuth refresh token', 'Secret. Minted once for the Google account that owns the channel, with the youtube.readonly scope.'],
    'channel_id'    => ['Channel ID', 'Optional. Starts with UC and is 24 characters long; used only to recognise the channel\'s own broadcasts.'],
];
/** Tier → words. */
const LIVE_SET_TIER_LABELS = [
    0 => 'Manual only',
    1 => 'API key — public broadcast data',
    2 => 'OAuth — owner broadcast data',
];
/** Numeric setting → [label, hint]; the ranges are LIVE_SETTING_RANGES. */
const LIVE_SET_NUMBER_LABELS = [
    'starting_lead_minutes'  => ['"Starting shortly" lead (minutes)', 'How close to its scheduled start an upcoming broadcast is shown as starting shortly. Only used when the switch above is on.'],
    'lead_minutes'           => ['Watch a broadcast from (minutes before start)', 'How long before its scheduled start the job begins checking a broadcast more often.'],
    'stale_hours'            => ['Give up on a live broadcast after (hours)', 'A broadcast YouTube still calls live this long after it started is marked ended and left for a person.'],
    'catchup_hours'          => ['Catch up on missed starts for (hours)', 'How long after its start the job keeps checking a broadcast that is still marked scheduled — after an outage, or the first time you turn automation on. Anything older is left for a person.'],
    'complete_grace_seconds' => ['Wait before marking a stream ended (seconds)', 'Once YouTube says a broadcast ended, the job waits this long before it marks the stream completed, in case the broadcast resumes.'],
    'poll_seconds_live'      => ['Check a live broadcast every (seconds)', 'At least 30 seconds: one check a minute is 1,440 units a day per live stream against the quota below.'],
    'poll_seconds_soon'      => ['Check a broadcast about to start every (seconds)', 'At least 30 seconds. Applies inside the lead time above; further out the job checks far less often.'],
    'backoff_max_seconds'    => ['Longest pause after repeated failures (seconds)', 'When YouTube keeps refusing, each retry waits longer, up to this. Never below 5 minutes.'],
    'daily_quota_units'      => ['Daily quota (units)', 'Google gives a project 10,000 units a day; each check costs 1 or 2. When this many are spent the job stops until midnight US Pacific time.'],
];

$db        = getDB();
$tables    = liveTablesExist();
$installed = $tables && liveAutomationInstalled();
$actor     = (string) (currentAdmin()['username'] ?? 'admin');

function liveSetFlash(string $type, string $text): void
{
    $_SESSION['flash_live_settings'] = [$type, $text];
}

/** A UTC 'Y-m-d H:i:s' instant in the temple's zone, for the status card. */
function liveSetLocal(?string $utc): string
{
    if ($utc === null || $utc === '') return '';
    $tz = liveTempleTz();
    return liveFromUtc($utc, $tz, 'j M Y, H:i') . ' ' . liveZoneLabel($tz, $utc);
}

/** The §3.3 sentence for oauth_revoked_reason. */
function liveSetRevokedSentence(string $reason): string
{
    return match ($reason) {
        'invalid_grant'  => 'The refresh token is no longer valid: mint a new refresh token for the channel\'s Google account and save it.',
        'invalid_client' => 'Google no longer accepts the saved OAuth client: check the client secret in Google Cloud, or save it again.',
        default          => '',
    };
}

// ── POST ─────────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAdminCan('live.provider');
    $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
    if (adminCsrfGuard() !== '') {
        liveSetFlash('error', 'Your session expired or the form was tampered with. Please reload and try again.');
    } elseif (!$installed) {
        liveSetFlash('error', 'YouTube automation is not installed yet: apply database migrations 011_live_streams.sql and 012_live_automation.sql first.');
    } elseif ($action === 'test_connection') {
        if (liveQuotaBlockedUntil() !== null) {
            liveSetFlash('warning', LIVE_PROVIDER_MESSAGES['quota']);
        } elseif (!rateLimitAllow('live-check-now', 30, 3600, $actor)) {
            liveSetFlash('warning', 'You have run a lot of checks in the last hour. The scheduled job is still running normally — try again shortly.');
        } elseif (!function_exists('curl_init')) {
            liveSetFlash('error', 'The PHP curl extension is not available on this server.');
        } else {
            // One videos.list on a well-formed id nothing is published under: an
            // empty items[] proves the credential works without printing it. The
            // probe ignores the mode so a key can be checked before automation is on.
            liveConfigReset();
            liveYoutubeRunStart($actor);
            $answer = liveYoutubeFetchMany([0 => ['id' => 0, 'provider_broadcast_id' => 'AAAAAAAAAA0']], true, true);
            ['tone' => $tone, 'text' => $text] = liveProviderConnectionMessage($answer);
            liveSetFlash($tone, $text);
            adminAudit('live_provider_test', 'YouTube automation', $tone . ': ' . $text);
        }
    } elseif ($action === 'reconnect') {
        if (trim(liveSetting('oauth_revoked_at')) === '') {
            liveSetFlash('warning', 'OAuth is not switched off, so there is nothing to reconnect.');
        } else {
            try {
                liveTransaction($db, function (PDO $db) use ($actor): void {
                    liveSettingWrite($db, 'oauth_revoked_at', '', $actor);
                    liveSettingWrite($db, 'oauth_revoked_reason', '', $actor);
                    $db->prepare('DELETE FROM live_settings WHERE k = :k')->execute([':k' => 'oauth_access_token']);
                    liveSettingWrite($db, 'oauth_access_token_expires_at', '', $actor);
                    [$where, $params] = liveSyncEligibleWhere();
                    $db->prepare("UPDATE live_streams s SET s.next_sync_at = NULL WHERE {$where}")->execute($params);
                    liveProviderFailStreak($db, null);
                    liveAudit('live_provider_settings', 'YouTube automation', 'reconnect', $actor);
                });
                liveConfigReset();
                liveSetFlash('success', 'OAuth switched back on. The next check will try the saved OAuth credentials once more.');
            } catch (Throwable $e) {
                error_log('[live] reconnect failed: ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
                liveSetFlash('error', 'OAuth could not be switched back on. Nothing was changed.');
            }
        }
    } elseif ($action === 'disconnect') {
        try {
            $removed = [];
            liveTransaction($db, function (PDO $db) use ($actor, &$removed): void {
                $rows = liveSettingsFresh($db, LIVE_SECRET_KEYS);
                foreach (LIVE_SECRET_KEYS as $k) {
                    if (isset($rows[$k])) $removed[] = $k;
                }
                $in = implode(',', array_fill(0, count(LIVE_SECRET_KEYS), '?'));
                $db->prepare("DELETE FROM live_settings WHERE k IN ({$in})")->execute(LIVE_SECRET_KEYS);
                liveSettingWrite($db, 'oauth_access_token_expires_at', '', $actor);
                liveSettingWrite($db, 'mode', 'off', $actor);
                liveAudit('live_provider_disconnected', 'YouTube automation', 'removed: ' . ($removed ? implode(', ', $removed) : 'nothing stored') . '; mode = off', $actor);
            });
            liveConfigReset();
            $envLeft = array_filter(LIVE_CREDENTIAL_FIELDS, static fn(string $f): bool => trim(envValue(LIVE_CREDENTIAL_ENV[$f])) !== '');
            liveSetFlash('success', 'YouTube disconnected: the stored keys were removed and automation is off.'
                . ($envLeft ? ' Credentials set in the server environment (' . implode(', ', array_map(static fn(string $f): string => LIVE_CREDENTIAL_ENV[$f], $envLeft)) . ') stay in force until the hosting panel removes them.' : ''));
        } catch (Throwable $e) {
            error_log('[live] disconnect failed: ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
            liveSetFlash('error', 'YouTube could not be disconnected. Nothing was changed.');
        }
    } elseif ($action === 'check_now') {
        if (!function_exists('liveCronRun')) {
            liveSetFlash('warning', 'The scheduled job is not installed on this server yet, so a check cannot be run from here.');
        } elseif (!rateLimitAllow('live-check-now', 30, 3600, $actor)) {
            liveSetFlash('warning', 'You have run a lot of checks in the last hour. The scheduled job is still running normally — try again shortly.');
        } else {
            $summary = liveCronRun(['limit' => 20, 'actor' => $actor, 'trigger' => 'admin']);
            if (!empty($summary['locked'])) {
                liveSetFlash('warning', 'A check is already going on (the scheduled one). Try again in a minute.');
            } else {
                $checked = (int) ($summary['checked'] ?? 0);
                $moved   = (int) ($summary['moved'] ?? 0);
                $notice  = trim((string) ($summary['notice'] ?? ''));
                liveSetFlash(
                    $notice !== '' ? 'warning' : 'success',
                    'Checked ' . $checked . ' stream' . ($checked === 1 ? '' : 's') . ', moved ' . $moved . '.' . ($notice !== '' ? ' ' . $notice : '')
                );
            }
        }
    } elseif ($action === 'save') {
        $cfg     = liveAutomationConfig();
        $keyOk   = liveSettingsKey() !== null;
        $errors  = [];
        $changes = [];
        $str     = static fn(string $k): string => is_scalar($_POST[$k] ?? null) ? trim((string) $_POST[$k]) : '';
        $credPosted = is_array($_POST['cred'] ?? null) ? $_POST['cred'] : [];
        $removeAsk  = is_array($_POST['remove'] ?? null) ? $_POST['remove'] : [];

        // 1. Credentials. Blank keeps what is stored; "Remove" clears it; a field
        //    supplied by the environment is never stored here.
        $status    = liveCredentialStatus();
        $effective = [];
        foreach (LIVE_CREDENTIAL_FIELDS as $field) {
            $key     = LIVE_CREDENTIAL_SETTING[$field];
            $current = $status[$field];
            $raw     = $credPosted[$field] ?? null;
            $remove  = !empty($removeAsk[$field]);
            $effective[$field] = $current['source'] === 'env' || $current['source'] === 'stored' ? liveCredential($field) : '';
            if ($current['source'] === 'env') continue;
            if ($remove) {
                $changes[$key] = null;
                $effective[$field] = '';
                continue;
            }
            if ($raw === null || $raw === '') continue;
            $label = LIVE_SET_FIELD_LABELS[$field][0];
            if (!is_scalar($raw)) {
                $errors[] = $label . ' is not a valid value.';
                continue;
            }
            $posted = trim((string) $raw);
            if ($posted === '') continue;
            if (mb_strlen($posted) > 300 || preg_match('/[\x00-\x1F\x7F]/', $posted)) {
                $errors[] = $label . ' is not a valid value.';
                continue;
            }
            if ($field === 'client_id' && !preg_match('/^[A-Za-z0-9._-]{1,200}$/D', $posted)) {
                $errors[] = 'The OAuth client ID may only contain letters, digits, dots, dashes and underscores.';
                continue;
            }
            if ($field === 'channel_id' && !preg_match('/^UC[A-Za-z0-9_-]{22}$/D', $posted)) {
                $errors[] = 'The Channel ID must start with UC and be 24 characters long.';
                continue;
            }
            if (!$keyOk) {
                $errors[] = 'YouTube credentials cannot be stored until LIVE_SETTINGS_KEY is set on the server, or put them in the server environment.';
                continue;
            }
            $changes[$key] = $posted;
            $effective[$field] = $posted;
        }
        // liveSettingsSaveMany() clears the OAuth revocation when any OAuth
        // credential changes, so the mode check below must see the same thing.
        // Secrets are always rewritten; the plain client ID only counts when it differs from what is stored.
        $storedClientId = liveSettingsRows()['youtube_client_id']['v'] ?? '';
        $oauthChanging  = isset($changes['youtube_client_secret']) || isset($changes['youtube_refresh_token'])
            || (array_key_exists('youtube_client_id', $changes) && ($changes['youtube_client_id'] ?? '') !== $storedClientId);

        // 2. Switches and numbers.
        foreach (['auto_starting', 'auto_start', 'auto_end'] as $flag) {
            $changes[$flag] = isset($_POST[$flag]) ? '1' : '0';
        }
        foreach (LIVE_SETTING_RANGES as $k => [$min, $max]) {
            $v = $str($k);
            if (!preg_match('/^\d{1,6}$/D', $v) || (int) $v < $min || (int) $v > $max) {
                $errors[] = LIVE_SET_NUMBER_LABELS[$k][0] . ' must be a whole number between ' . number_format($min) . ' and ' . number_format($max) . '.';
                continue;
            }
            $changes[$k] = (string) (int) $v;
        }

        // 3. Mode — checked against the credentials that will be in force after
        //    this save, not the ones before it.
        $mode = $str('mode');
        if (!in_array($mode, LIVE_MODES, true)) $mode = $cfg['mode'];
        if ($mode === 'simulator' && !$cfg['simulator_allowed']) {
            $errors[] = 'The YouTube stand-in (Simulator) is only for development servers (LIVE_ALLOW_SIMULATOR=1).';
            $mode = $cfg['mode'] === 'simulator' ? 'off' : $cfg['mode'];
        }
        if ($mode === 'live') {
            $trio = $effective['client_id'] !== '' && $effective['client_secret'] !== '' && $effective['refresh_token'] !== '';
            if ($effective['api_key'] === '' && !($trio && ($oauthChanging || $cfg['oauth_revoked_at'] === null))) {
                $errors[] = 'Live needs a YouTube API key, or a working OAuth client ID, client secret and refresh token, before it can be chosen.';
                $mode = $cfg['mode'] === 'live' ? 'off' : $cfg['mode'];
            } elseif (!function_exists('curl_init')) {
                $errors[] = 'The PHP curl extension is not available on this server.';
                $mode = $cfg['mode'] === 'live' ? 'off' : $cfg['mode'];
            }
        }
        $changes['mode'] = $mode;

        try {
            $changed = liveSettingsSaveMany($db, $changes, $actor);
            // Re-check against what is actually stored now: a save that raced
            // another one may have left Live on without a usable credential.
            if ($mode === 'live' && liveAutomationTier() < 1) {
                liveSettingsSaveMany($db, ['mode' => 'off'], $actor);
                $changed = array_values(array_diff($changed, ['mode']));
                $errors[] = 'Live needs a YouTube API key, or a working OAuth client ID, client secret and refresh token, before it can be chosen.';
            }
            $saved = $changed ? count($changed) . ' setting' . (count($changed) === 1 ? '' : 's') . ' saved (' . implode(', ', $changed) . ').' : 'Nothing changed.';
            if ($errors) {
                liveSetFlash('warning', $saved . ' Not everything could be applied: ' . implode(' ', array_unique($errors)));
            } else {
                liveSetFlash('success', $saved);
            }
        } catch (Throwable $e) {
            error_log('[live] settings save failed: ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
            liveSetFlash('error', 'The settings could not be saved. Nothing was changed.');
        }
    } else {
        liveSetFlash('error', 'That action is not available on this page.');
    }
    header('Location: ' . LIVE_SET_BASE, true, 303);
    exit;
}

// ── Page ─────────────────────────────────────────────────────────────────────
$msg = '';
if (!empty($_SESSION['flash_live_settings'])) {
    [$fType, $fText] = $_SESSION['flash_live_settings'];
    unset($_SESSION['flash_live_settings']);
    $tone = in_array($fType, ['success', 'warning', 'error'], true) ? $fType : 'success';
    $msg  = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'success' ? 'status' : 'alert') . '">' . h($fText) . '</p>';
}

adminHeader('YouTube Automation', 'Content', [
    'actions' => '<a href="/admin/live_streams.php" class="btn btn-ghost btn--sm">' . adminIcon('video') . 'Live Streams</a>',
]);
echo $msg;

if (!$installed) {
    echo adminEmpty(
        'refresh',
        'YouTube automation is not installed yet',
        $tables
            ? 'Apply database migration 012_live_automation.sql (see README), then come back to switch it on.'
            : 'Apply database migrations 011_live_streams.sql and 012_live_automation.sql (see README), then come back to switch it on.'
    );
    adminFooter();
    exit;
}

$cfg      = liveAutomationConfig();
$ready    = liveAutomationReady();
$mode     = $cfg['mode'];
$keyOk    = liveSettingsKey() !== null;
$cronOk   = trim(envValue('LIVE_CRON_KEY')) !== '';
$statuses = liveCredentialStatus();
$revoked  = $cfg['oauth_revoked_at'] !== null;
$blocked  = liveQuotaBlockedUntil();
$quotaUsed = $cfg['quota_day'] === livePacificDay() ? $cfg['quota_units'] : 0;
$anyStored = (bool) array_filter($statuses, static fn(array $s): bool => in_array($s['source'], ['stored', 'unreadable'], true));

$statusHeadline = match (true) {
    $ready['ok'] && $mode === 'live' => 'YouTube automation is on: the scheduled job reads the channel\'s broadcasts and moves stream statuses by itself.',
    $ready['ok']                     => 'YouTube automation is running against the stand-in on this server. Nothing reaches YouTube.',
    default                          => $ready['reason'],
};
$statusTone = $ready['ok'] ? ($mode === 'live' ? 'success' : 'warning') : 'muted';

echo adminPageIntro(
    'How the website follows the temple\'s YouTube channel: which keys it uses, whether it may move a stream to "starting", "live" and "ended" by itself, and how often it asks YouTube. Only owners can open this page.',
    adminBadge(strtoupper($mode), $statusTone) . ' ' . adminBadge(LIVE_SET_TIER_LABELS[$ready['tier']], $ready['tier'] > 0 ? 'success' : 'muted')
);
?>

<section class="card card--static" aria-labelledby="live-status-title">
  <div class="card__head">
    <h2 id="live-status-title"><?= adminIcon('activity', 'ico--sm') ?> Status</h2>
    <?= adminBadge($ready['ok'] ? 'Ready' : 'Not checking YouTube', $ready['ok'] ? 'success' : 'warning') ?>
  </div>
  <div class="card__body">
    <p class="<?= $ready['ok'] ? 'muted' : 'alert alert--warning' ?>"<?= $ready['ok'] ? '' : ' role="status"' ?>><?= h($statusHeadline) ?></p>
    <?php if ($revoked): ?>
      <div class="alert alert--error" role="alert">
        <p><strong>OAuth: switched off on <?= h(liveSetLocal($cfg['oauth_revoked_at'])) ?> because Google refused the saved OAuth credentials.</strong>
          <?= h(liveSetRevokedSentence($cfg['oauth_revoked_reason'])) ?></p>
        <button type="submit" form="live-reconnect" class="btn btn--sm mt-2"><?= adminIcon('refresh') ?> Reconnect</button>
        <span class="field__hint">Switches OAuth back on so the next check tries the saved credentials once more. Save the corrected credential first.</span>
      </div>
    <?php endif; ?>
    <?php if ($blocked !== null): ?>
      <p class="alert alert--warning" role="status"><?= adminIcon('clock') ?> The day's YouTube quota is used up. Checks resume at <?= h(liveSetLocal($blocked)) ?>.</p>
    <?php endif; ?>
    <?php if (trim($cfg['provider_notice']) !== ''): ?>
      <p class="alert alert--warning" role="status"><?= adminIcon('info') ?> YouTube said, at the last check: <?= h($cfg['provider_notice']) ?></p>
    <?php endif; ?>
    <dl class="dl-grid">
      <dt>Mode</dt><dd><?= adminBadge(strtoupper($mode), $statusTone) ?></dd>
      <dt>Access</dt><dd><?= adminBadge(LIVE_SET_TIER_LABELS[$ready['tier']], $ready['tier'] > 0 ? 'success' : 'muted') ?>
          <span class="field__hint">With an API key the job sees what any viewer sees; with OAuth it also reads the channel owner's broadcast details.</span></dd>
      <dt>Today's quota</dt>
      <dd><span class="tabular"><?= number_format($quotaUsed) ?></span> of <span class="tabular"><?= number_format($cfg['daily_quota_units']) ?></span> units
          <span class="field__hint">Google's day is <?= h(livePacificDay()) ?> (US Pacific); the count restarts at midnight there.</span></dd>
      <dt>LIVE_SETTINGS_KEY</dt>
      <dd><?= $keyOk ? adminBadge('Set', 'success') : adminBadge('Not set', 'warning') ?>
          <span class="field__hint"><?= $keyOk ? 'Keys typed below are stored encrypted.' : 'Without it, keys can only come from the server environment.' ?></span></dd>
      <dt>LIVE_CRON_KEY</dt>
      <dd><?= $cronOk ? adminBadge('Set', 'success') : adminBadge('Not set', 'warning') ?>
          <span class="field__hint"><?= $cronOk ? 'The hosting panel\'s cron job can call the checker.' : 'Set it, and point a cron job at the checker, or nothing runs on a schedule.' ?></span></dd>
      <dt>Database</dt><dd><?= adminBadge('Migration 012 applied', 'success') ?></dd>
      <dt>Simulator</dt>
      <dd><?= $cfg['simulator_allowed'] ? adminBadge('YouTube stand-in: allowed on this server', 'danger') : adminBadge('Not allowed', 'muted') ?></dd>
      <?php if ($cfg['oauth_access_token_expires_at'] !== null): ?>
        <dt>Google sign-in valid until</dt><dd><?= h(liveSetLocal($cfg['oauth_access_token_expires_at'])) ?></dd>
      <?php endif; ?>
      <?php if ($cfg['provider_fail_streak'] > 0): ?>
        <dt>Failed checks in a row</dt><dd><span class="tabular"><?= (int) $cfg['provider_fail_streak'] ?></span></dd>
      <?php endif; ?>
    </dl>
    <p class="callout mt-4"><?= adminIcon('info') ?> A Google Cloud project whose OAuth consent screen is in Testing with an external user type is issued refresh tokens that expire after 7 days. Publish the app, or add this Google account as an internal user, before relying on OAuth.</p>
  </div>
</section>

<form method="POST" action="<?= LIVE_SET_BASE ?>" class="pay-settings mt-6">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="save" />

  <section class="card card--static" aria-labelledby="live-mode-title">
    <div class="card__head"><h2 id="live-mode-title"><?= adminIcon('toggle', 'ico--sm') ?> Mode</h2></div>
    <div class="card__body">
      <fieldset>
        <legend class="field__label">Should the job ask YouTube?</legend>
        <label class="choice">
          <input type="radio" name="mode" value="off"<?= $mode === 'off' ? ' checked' : '' ?> />
          <span><strong>Off</strong><span class="field__hint">Statuses are changed by hand on the Live Streams page only.</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="mode" value="live"<?= $mode === 'live' ? ' checked' : '' ?> />
          <span><strong>Live</strong><span class="field__hint">The scheduled job asks YouTube about each stream and moves its status. Needs a credential below.</span></span>
        </label>
        <?php if ($cfg['simulator_allowed']): ?>
        <label class="choice">
          <input type="radio" name="mode" value="simulator"<?= $mode === 'simulator' ? ' checked' : '' ?> />
          <span><strong>Simulator</strong><span class="field__hint">Development only. A stand-in for YouTube on this server; nothing reaches Google.</span></span>
        </label>
        <?php endif; ?>
      </fieldset>

      <div class="settings-list mt-4">
        <?php foreach ([
            ['auto_starting', 'Show "starting shortly" before the broadcast begins', 'Shows a broadcast as \'starting shortly\' when YouTube still says it is upcoming and the start is close. This is the one thing the job guesses rather than observes — leave it off until you have watched a broadcast go through.'],
            ['auto_start', 'Mark a stream live when YouTube does', 'When YouTube reports the broadcast is live, the stream goes live on the website.'],
            ['auto_end', 'Mark a stream ended when YouTube does', 'When YouTube reports the broadcast has ended, the stream is completed on the website after the grace period below.'],
        ] as [$key, $label, $desc]): ?>
          <div class="settings-row">
            <div class="settings-row__text">
              <strong id="<?= h($key) ?>-title"><?= h($label) ?></strong>
              <span id="<?= h($key) ?>-desc"><?= h($desc) ?></span>
            </div>
            <label class="switch">
              <input type="checkbox" role="switch" name="<?= h($key) ?>" value="1"<?= $cfg[$key] ? ' checked' : '' ?>
                     aria-labelledby="<?= h($key) ?>-title" aria-describedby="<?= h($key) ?>-desc" />
              <span class="switch__track" aria-hidden="true"></span>
            </label>
          </div>
        <?php endforeach; ?>
      </div>
    </div>
  </section>

  <section class="card card--static mt-6" aria-labelledby="live-cred-title">
    <div class="card__head">
      <h2 id="live-cred-title"><?= adminIcon('key', 'ico--sm') ?> YouTube credentials</h2>
      <?= $keyOk ? adminBadge('Stored encrypted', 'success') : adminBadge('Read-only: no settings key', 'warning') ?>
    </div>
    <div class="card__body">
      <?php if (!$keyOk): ?>
        <p class="alert alert--warning" role="status" data-keep>Set <code>LIVE_SETTINGS_KEY</code> to store keys here, or put them in the environment.
          Generate one with <code>php -r "echo base64_encode(random_bytes(32));"</code> and add it to the hosting panel.</p>
      <?php endif; ?>
      <fieldset class="pay-cred">
        <legend class="field__label">Google Cloud project</legend>
        <?php foreach (LIVE_SET_FIELD_LABELS as $field => [$label, $hint]):
            $s       = $statuses[$field];
            $id      = "cred-{$field}";
            $fromEnv = $s['source'] === 'env';
            $locked  = $fromEnv || !$keyOk;
            $place   = match ($s['source']) {
                'env'        => 'Set in the server environment (' . $s['env'] . ')',
                'stored'     => '•••• ' . $s['last4'] . ' (stored)',
                'unreadable' => 'Stored, but it cannot be read with this LIVE_SETTINGS_KEY',
                default      => 'Not set',
            };
        ?>
        <div class="pay-cred__row">
          <label for="<?= h($id) ?>">
            <span class="field__label"><?= h($label) ?></span>
            <span class="field-with-button">
              <input id="<?= h($id) ?>" type="password" name="cred[<?= h($field) ?>]"
                     autocomplete="off" spellcheck="false" maxlength="300" placeholder="<?= h($place) ?>"<?= $locked ? ' disabled' : '' ?> />
              <?php if (!$locked): ?>
                <button type="button" class="btn btn-ghost btn--icon btn--sm" data-toggle-password="<?= h($id) ?>" aria-pressed="false" aria-label="Show <?= h($label) ?>"><?= adminIcon('eye') ?></button>
              <?php endif; ?>
            </span>
            <span class="field__hint"><?= h($hint) ?> <?= $fromEnv ? 'This one comes from the server environment and cannot be changed here.' : 'Leave blank to keep what is stored.' ?></span>
          </label>
          <?php if (!$fromEnv && in_array($s['source'], ['stored', 'unreadable'], true)): ?>
            <label class="pay-cred__remove" for="rm-<?= h($id) ?>">
              <input id="rm-<?= h($id) ?>" type="checkbox" name="remove[<?= h($field) ?>]" value="1" />
              <span>Remove</span>
            </label>
          <?php endif; ?>
        </div>
        <?php endforeach; ?>
        <div class="cluster">
          <button type="submit" form="test-youtube" class="btn btn--sm"><?= adminIcon('flask') ?> Test the YouTube connection</button>
          <span class="field__hint">Asks YouTube about a video that does not exist. An empty answer means the key works. Costs one or two quota units.</span>
        </div>
      </fieldset>
    </div>
  </section>

  <section class="card card--static mt-6" aria-labelledby="live-timing-title">
    <div class="card__head"><h2 id="live-timing-title"><?= adminIcon('clock', 'ico--sm') ?> Timing and quota</h2></div>
    <div class="card__body">
      <div class="form-grid">
        <?php foreach (LIVE_SET_NUMBER_LABELS as $key => [$label, $hint]): [$min, $max] = LIVE_SETTING_RANGES[$key]; ?>
          <label for="<?= h($key) ?>">
            <span class="field__label"><?= h($label) ?></span>
            <input id="<?= h($key) ?>" type="number" name="<?= h($key) ?>" value="<?= (int) $cfg[$key] ?>" min="<?= $min ?>" max="<?= $max ?>" step="1" inputmode="numeric" />
            <span class="field__hint"><?= h($hint) ?> Between <?= number_format($min) ?> and <?= number_format($max) ?>.</span>
          </label>
        <?php endforeach; ?>
      </div>
    </div>
  </section>

  <div class="form-actions mt-6">
    <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save YouTube settings</button>
  </div>
</form>

<section class="card card--static mt-6" aria-labelledby="live-actions-title">
  <div class="card__head"><h2 id="live-actions-title"><?= adminIcon('refresh', 'ico--sm') ?> Actions</h2></div>
  <div class="card__body">
    <div class="cluster">
      <button type="submit" form="live-check-now" class="btn btn--sm"<?= function_exists('liveCronRun') ? '' : ' disabled aria-disabled="true"' ?>><?= adminIcon('refresh') ?> Run a check now</button>
      <span class="field__hint"><?= function_exists('liveCronRun') ? 'Checks every stream that is due, exactly as the scheduled job would.' : 'The scheduled job is not installed on this server yet.' ?></span>
    </div>
    <div class="cluster mt-4">
      <button type="submit" form="live-disconnect" class="btn btn-danger btn--sm"<?= $anyStored || $mode !== 'off' ? '' : ' disabled aria-disabled="true"' ?>
              data-confirm="Remove every stored YouTube key and switch automation off? Streams keep their current status." data-confirm-label="Disconnect">
        <?= adminIcon('x') ?> Disconnect YouTube</button>
      <span class="field__hint">Removes the stored API key, client secret, refresh token and cached sign-in, and sets the mode to Off. Never changes a stream.</span>
    </div>
  </div>
</section>

<?php foreach (['test-youtube' => 'test_connection', 'live-reconnect' => 'reconnect', 'live-disconnect' => 'disconnect', 'live-check-now' => 'check_now'] as $formId => $formAction): ?>
<form method="POST" action="<?= LIVE_SET_BASE ?>" id="<?= h($formId) ?>" class="sr-only">
  <?= csrfField() ?>
  <input type="hidden" name="action" value="<?= h($formAction) ?>" />
</form>
<?php endforeach; ?>

<?php adminFooter(); ?>
