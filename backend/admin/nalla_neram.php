<?php
// backend/admin/nalla_neram.php — Temple → Nalla Neram: the two auspicious
// windows per weekday that the Panchangam page, the homepage strip and the
// Nalla Neram cards show (brief §6, §8, §15). Stored as the json setting
// `nalla_neram` (migration 025); includes/panchangam.php reads it.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_settings.php';
require_once __DIR__ . '/includes/admin_layout.php';

$days = [['ஞாயிறு', 'Sunday'], ['திங்கள்', 'Monday'], ['செவ்வாய்', 'Tuesday'], ['புதன்', 'Wednesday'], ['வியாழன்', 'Thursday'], ['வெள்ளி', 'Friday'], ['சனி', 'Saturday']];
$ready = siteSettingsReady();
$clock = static fn(string $t): bool => preg_match('/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/', $t) === 1;

$msg = '';
if (!empty($_SESSION['admin_flash']) && is_array($_SESSION['admin_flash'])) {
    $flash = $_SESSION['admin_flash'];
    unset($_SESSION['admin_flash']);
    $tone = in_array($flash['type'] ?? '', ['success', 'error', 'warning', 'info'], true) ? $flash['type'] : 'info';
    if (($flash['text'] ?? '') !== '') $msg = '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h($flash['text']) . '</p>';
}

$errors = [];
$table  = siteSettingJson('nalla_neram');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $ready) {
    $msg = adminCsrfGuard();
    if ($msg === '') {
        $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
        if ($action === 'reset') {
            siteSettingsSave(['nalla_neram' => null], (string) ($_SESSION['admin_user'] ?? 'admin'));
            adminAudit('nalla_neram_saved', 'site_settings:nalla_neram', 'reset to the built-in table');
            $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Nalla Neram reset to the built-in table.'];
            header('Location: /admin/nalla_neram.php');
            exit;
        }
        $new = [];
        for ($d = 0; $d < 7; $d++) {
            $new[$d] = [];
            for ($w = 0; $w < 2; $w++) {
                $from = trim((string) ($_POST["from_{$d}_{$w}"] ?? ''));
                $to   = trim((string) ($_POST["to_{$d}_{$w}"] ?? ''));
                if (!$clock($from) || !$clock($to)) { $errors["{$d}_{$w}"] = 'Enter both times as HH:MM.'; $new[$d][] = [$from, $to]; continue; }
                if ($to <= $from) { $errors["{$d}_{$w}"] = 'The window must end after it starts.'; }
                $new[$d][] = [$from, $to];
            }
        }
        if ($errors) {
            $table = $new;
            $msg = '<p class="alert alert--error" role="alert">Please fix the highlighted window' . (count($errors) === 1 ? '' : 's') . ' and save again.</p>';
        } else {
            $changed = siteSettingsSave(['nalla_neram' => json_encode($new, JSON_UNESCAPED_UNICODE)], (string) ($_SESSION['admin_user'] ?? 'admin'));
            adminAudit('nalla_neram_saved', 'site_settings:nalla_neram', $changed ? 'windows changed' : 'no changes');
            $_SESSION['admin_flash'] = ['type' => 'success', 'text' => 'Nalla Neram saved — the website shows the new windows immediately.'];
            header('Location: /admin/nalla_neram.php');
            exit;
        }
    }
}
$edited = ($ready && (siteSettingsAll()['nalla_neram']['edited'] ?? false));

adminHeader('Nalla Neram', 'Temple', ['actions' => '<a href="/panchangam" target="_blank" rel="noopener" class="btn btn--sm">' . adminIcon('external') . 'Panchangam page</a>']);
echo $msg;
echo adminPageIntro('The auspicious windows for each weekday, as the Panchangam page, the homepage strip and the Nalla Neram cards show them. Times are IST; 24:00 means midnight at the end of the day.');
if (!$ready): ?>
  <div class="callout"><?= adminIcon('alert') ?><p>Run <code>database/migrations/025_cms_pages_settings.sql</code> against this database to edit Nalla Neram; until then the built-in table applies.</p></div>
<?php adminFooter(); exit; endif; ?>

<section class="card card--static" aria-labelledby="nn-title">
  <div class="card__head">
    <h2 id="nn-title"><?= adminIcon('clock', 'ico--sm') ?> Weekly windows</h2>
    <?= adminBadge($edited ? 'Edited by the committee' : 'Built-in table', $edited ? 'success' : 'muted') ?>
  </div>
  <form method="POST" action="/admin/nalla_neram.php">
    <?= csrfField() ?>
    <input type="hidden" name="action" value="save" />
    <div class="table-wrap">
      <table class="table" data-no-search>
        <thead><tr><th scope="col">Day</th><th scope="col">Morning window</th><th scope="col">Evening window</th></tr></thead>
        <tbody>
        <?php foreach ($days as $d => [$ta, $en]): ?>
          <tr>
            <th scope="row"><span class="cell-title" lang="ta"><?= h($ta) ?></span><span class="cell-sub"><?= h($en) ?></span></th>
            <?php for ($w = 0; $w < 2; $w++): $k = "{$d}_{$w}"; $win = $table[$d][$w] ?? ['', '']; ?>
              <td>
                <div class="cluster<?= isset($errors[$k]) ? ' field--error' : '' ?>">
                  <label class="sr-only" for="from-<?= $k ?>"><?= h($en) ?> window <?= $w + 1 ?> from</label>
                  <input id="from-<?= $k ?>" type="text" name="from_<?= $k ?>" value="<?= h((string) ($win[0] ?? '')) ?>" pattern="([01]\d|2[0-3]):[0-5]\d|24:00" placeholder="07:30" inputmode="numeric" size="6"<?= isset($errors[$k]) ? ' aria-invalid="true" aria-describedby="err-' . $k . '"' : '' ?> />
                  <span aria-hidden="true">–</span>
                  <label class="sr-only" for="to-<?= $k ?>"><?= h($en) ?> window <?= $w + 1 ?> to</label>
                  <input id="to-<?= $k ?>" type="text" name="to_<?= $k ?>" value="<?= h((string) ($win[1] ?? '')) ?>" pattern="([01]\d|2[0-3]):[0-5]\d|24:00" placeholder="09:00" inputmode="numeric" size="6"<?= isset($errors[$k]) ? ' aria-invalid="true"' : '' ?> />
                </div>
                <?php if (isset($errors[$k])): ?><span class="field__error" id="err-<?= $k ?>" role="alert"><?= adminIcon('alert-circle') ?><?= h($errors[$k]) ?></span><?php endif; ?>
              </td>
            <?php endfor; ?>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save windows</button>
    </div>
  </form>
  <?php if ($edited): ?>
  <form method="POST" action="/admin/nalla_neram.php" class="mt-4">
    <?= csrfField() ?>
    <input type="hidden" name="action" value="reset" />
    <button type="submit" class="btn btn-ghost btn--sm" data-confirm="Go back to the built-in Nalla Neram table? The windows you saved are discarded." data-confirm-label="Reset"><?= adminIcon('refresh') ?> Reset to the built-in table</button>
  </form>
  <?php endif; ?>
</section>
<?php adminFooter(); ?>
