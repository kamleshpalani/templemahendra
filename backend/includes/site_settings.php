<?php
/**
 * backend/includes/site_settings.php — the temple's own facts and copy, editable
 * in the admin (brief §3 "configurable through the CMS", §15 System → Settings
 * / Languages / SEO, Temple → Nalla Neram, Content → Pages).
 *
 * site_settings (migration 025) holds one row per key. A NULL cell means "not
 * edited yet" and the default in siteSettingCatalogue() applies, so a fresh
 * install — or a database without the migration — behaves exactly as before.
 * Readers: api/settings.php (the public subset), api/pulse.php (hours, the
 * daily schedule, today's special), includes/panchangam.php (Nalla Neram),
 * includes/contact_notify.php (the office address), the React app through
 * /api/settings, and og.php / spa.php / sitemap.php through the SEO overrides.
 *
 * Kinds: text and textarea are bilingual (value_ta / value_en); url, email,
 * phone, number and json are language-neutral (value).
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

const SITE_SETTING_GROUPS = [
    'identity'  => 'Temple & contact',
    'hours'     => 'Hours & daily schedule',
    'homepage'  => 'Homepage',
    'social'    => 'Social links',
    'office'    => 'Office alerts',
    'languages' => 'Languages',
];

/**
 * key => [group, kind, label, hint, public, default]
 * default: ['ta' => …, 'en' => …] for bilingual kinds, a string for the rest,
 * null when the site keeps using its built-in constants until edited.
 */
function siteSettingCatalogue(): array
{
    static $c = null;
    if ($c !== null) return $c;
    return $c = [
        // ── Temple & contact ────────────────────────────────────────────────
        'temple_name'       => ['identity', 'text', 'Temple name', 'The name in the header, the footer and shared links.', true, null],
        'temple_descriptor' => ['identity', 'text', 'Descriptor', 'The line under the name, e.g. the kula deivam descriptor.', true, null],
        'temple_address'    => ['identity', 'textarea', 'Postal address', 'As printed on the booklet; shown in the footer and on Contact.', true, null],
        'phone_primary'     => ['identity', 'phone', 'Primary phone', 'International digits, e.g. +916379227382. Shown on the homepage and Contact.', true, '+916379227382'],
        'phone_secondary'   => ['identity', 'phone', 'Secondary phone', 'Optional second number for enquiries.', true, '+917373016302'],
        'email'             => ['identity', 'email', 'Public e-mail', 'The address visitors write to.', true, templeIdentity()['email']],
        'maps_query'        => ['identity', 'value', 'Google Maps search text', 'What the Directions link and the map embed search for.', true, null],
        // ── Hours & daily schedule ──────────────────────────────────────────
        'temple_hours'      => ['hours', 'json', 'Opening hours', 'Morning and evening windows (IST).', true, '[{"open":"06:00","close":"12:30"},{"open":"16:00","close":"21:00"}]'],
        'pooja_schedule'    => ['hours', 'json', 'Daily pooja schedule', 'One pooja per line: HH:MM | Tamil name | English name.', true,
            '[{"time":"06:00","ta":"திருவனந்தல்","en":"Thiruvanandal"},{"time":"08:00","ta":"காலசந்தி","en":"Kalasanthi"},{"time":"12:00","ta":"உச்சிக்கால பூஜை","en":"Uchikala Pooja"},{"time":"16:30","ta":"சாயரட்சை","en":"Sayaratchai"},{"time":"18:30","ta":"இரண்டாம்கால","en":"Irandamkaalai"},{"time":"20:30","ta":"அர்த்த ஜாமம்","en":"Ardha Jamam"}]'],
        'daily_special'     => ['hours', 'json', "Today's special, by weekday", 'Seven lines, Sunday first: Tamil | English.', true,
            '[{"ta":"ஆதிமூலம் அலங்காரம்","en":"Spl Alankaram"},{"ta":"வெள்ளி அலங்காரம்","en":"Silver Alankaram"},{"ta":"பால் அபிஷேகம்","en":"Milk Abhishekam"},{"ta":"குங்குமார்ச்சனை","en":"Kumkum Archana"},{"ta":"பன்னீர் அபிஷேகம்","en":"Rosewater Abhishekam"},{"ta":"நவதானிய அர்ப்பணம்","en":"Navadhanya Offering"},{"ta":"விளக்கு பூஜை","en":"Deepa Pooja"}]'],
        'nalla_neram'       => ['hours', 'json', 'Nalla Neram', 'Two auspicious windows per weekday, Sunday first (edited under Temple → Nalla Neram).', true,
            '[[["07:30","09:00"],["22:30","24:00"]],[["06:00","07:30"],["15:00","16:30"]],[["07:30","09:00"],["22:30","24:00"]],[["07:30","09:00"],["12:00","13:30"]],[["10:30","12:00"],["19:30","21:00"]],[["10:30","12:00"],["16:30","18:00"]],[["06:00","07:30"],["19:30","21:00"]]]'],
        'pournami_timing'   => ['hours', 'value', 'Pournami pooja timing', 'Shown on the Pournami cards when the pooja has no typed times, e.g. 04:00 PM – 09:00 PM.', true, '04:00 PM – 09:00 PM'],
        // ── Homepage ────────────────────────────────────────────────────────
        'hero_title'        => ['homepage', 'text', 'Hero title', 'Leave empty to show the temple name.', true, null],
        'hero_lead'         => ['homepage', 'textarea', 'Hero lead', 'The sentence under the hero title; also the homepage description for search engines.', true, null],
        'intro'             => ['homepage', 'textarea', 'Temple introduction', 'A short welcome shown under the hero. Blank lines separate paragraphs.', true, null],
        'coming_soon_days'  => ['homepage', 'number', '"Coming soon" threshold (days)', 'A pooja further away than this shows as Coming Soon rather than Upcoming Pooja.', true, '3'],
        // ── Social links ────────────────────────────────────────────────────
        'social_youtube'    => ['social', 'url', 'YouTube channel', 'https://youtube.com/@… — also used by the Live Darshan page.', true, null],
        'social_facebook'   => ['social', 'url', 'Facebook page', '', true, null],
        'social_instagram'  => ['social', 'url', 'Instagram', '', true, null],
        'social_whatsapp'   => ['social', 'url', 'WhatsApp', 'A wa.me link or WhatsApp channel address.', true, null],
        // ── Office alerts (private) ─────────────────────────────────────────
        'contact_notify_email' => ['office', 'email', 'Contact-form alerts go to', 'One address or several separated by commas. An environment value (CONTACT_NOTIFY_EMAIL) wins over this.', false, null],
        'contact_notify_lang'  => ['office', 'value', 'Alert language', 'en or ta.', false, 'en'],
        // ── Languages ───────────────────────────────────────────────────────
        'languages_enabled' => ['languages', 'value', 'Languages offered', 'Comma-separated codes; ta and en are the two the site has words for.', true, 'ta,en'],
        'language_default'  => ['languages', 'value', 'Default language', 'What a first-time visitor sees.', true, 'ta'],
    ];
}

/** True when migration 025's table exists (cached per request). */
function siteSettingsReady(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;
    try {
        getDB()->query('SELECT 1 FROM site_settings LIMIT 0')->closeCursor();
        return $ready = true;
    } catch (Throwable) {
        return $ready = false;
    }
}

function siteSettingIsBilingual(string $kind): bool
{
    return $kind === 'text' || $kind === 'textarea';
}

/**
 * Every setting, defaults overlaid with what the committee saved:
 * key => ['ta' => ?string, 'en' => ?string, 'value' => ?string, 'edited' => bool, 'updated_at' => ?string]
 */
function siteSettingsAll(bool $reset = false): array
{
    static $cache = null;
    if ($reset) $cache = null;
    if ($cache !== null) return $cache;

    $out = [];
    foreach (siteSettingCatalogue() as $key => [$group, $kind, $label, $hint, $public, $default]) {
        $out[$key] = [
            'ta'    => is_array($default) ? ($default['ta'] ?? null) : null,
            'en'    => is_array($default) ? ($default['en'] ?? null) : null,
            'value' => is_array($default) ? null : $default,
            'edited' => false,
            'updated_at' => null,
        ];
    }
    if (siteSettingsReady()) {
        try {
            foreach (getDB()->query('SELECT key_name, value_ta, value_en, value, updated_at FROM site_settings')->fetchAll() as $r) {
                $k = (string) $r['key_name'];
                if (!isset($out[$k])) continue;
                $edited = false;
                foreach (['value_ta' => 'ta', 'value_en' => 'en', 'value' => 'value'] as $col => $slot) {
                    if ($r[$col] !== null && trim((string) $r[$col]) !== '') {
                        $out[$k][$slot] = (string) $r[$col];
                        $edited = true;
                    }
                }
                $out[$k]['edited'] = $edited;
                $out[$k]['updated_at'] = $r['updated_at'];
            }
        } catch (Throwable $e) {
            error_log('[site-settings] read failed: ' . $e->getMessage());
        }
    }
    return $cache = $out;
}

/**
 * One setting. Bilingual kinds: the text in $lang (falling back to the other
 * language), or [ta, en] when $lang is null. Other kinds: the value string.
 * Null when nothing is set and there is no default.
 */
function siteSetting(string $key, ?string $lang = null): mixed
{
    $all = siteSettingsAll();
    if (!isset($all[$key])) return null;
    $kind = siteSettingCatalogue()[$key][1];
    $s = $all[$key];
    if (!siteSettingIsBilingual($kind)) return $s['value'];
    if ($lang === null) return ['ta' => $s['ta'], 'en' => $s['en']];
    $primary = $lang === 'ta' ? $s['ta'] : $s['en'];
    $other   = $lang === 'ta' ? $s['en'] : $s['ta'];
    return $primary !== null && $primary !== '' ? $primary : $other;
}

/** A json-kind setting decoded, or the default when what is stored is not valid JSON. */
function siteSettingJson(string $key): array
{
    $raw = siteSetting($key);
    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) return $decoded;
    }
    $default = siteSettingCatalogue()[$key][5] ?? null;
    $decoded = is_string($default) ? json_decode($default, true) : null;
    return is_array($decoded) ? $decoded : [];
}

/** The public subset, for GET /api/settings: key => {ta, en, value}. Private keys never leave the server. */
function siteSettingsPublic(): array
{
    $out = [];
    foreach (siteSettingCatalogue() as $key => [$group, $kind, $label, $hint, $public]) {
        if (!$public) continue;
        $s = siteSettingsAll()[$key];
        $out[$key] = siteSettingIsBilingual($kind)
            ? ['ta' => $s['ta'], 'en' => $s['en']]
            : ($kind === 'json' ? siteSettingJson($key) : $s['value']);
    }
    return $out;
}

/**
 * Save edited values. $changes: key => ['ta' => …, 'en' => …] or key => 'value'.
 * Empty strings store NULL (back to the default). Returns the keys whose
 * stored value changed, for the audit row.
 */
function siteSettingsSave(array $changes, ?string $actor): array
{
    if (!siteSettingsReady()) return [];
    $db  = getDB();
    $cat = siteSettingCatalogue();
    $before = siteSettingsAll(true);
    $stmt = $db->prepare(
        'INSERT INTO site_settings (key_name, value_ta, value_en, value, updated_by) VALUES (:k, :ta, :en, :v, :by)
         ON DUPLICATE KEY UPDATE value_ta = VALUES(value_ta), value_en = VALUES(value_en), value = VALUES(value), updated_by = VALUES(updated_by)'
    );
    $changed = [];
    foreach ($changes as $key => $val) {
        if (!isset($cat[$key])) continue;
        $kind = $cat[$key][1];
        $nul = static fn($v): ?string => ($v === null || trim((string) $v) === '') ? null : (string) $v;
        if (siteSettingIsBilingual($kind)) {
            $ta = $nul(is_array($val) ? ($val['ta'] ?? null) : null);
            $en = $nul(is_array($val) ? ($val['en'] ?? null) : null);
            $v  = null;
        } else {
            $ta = $en = null;
            $v  = $nul(is_array($val) ? ($val['value'] ?? null) : $val);
        }
        $old = $before[$key];
        $prev = siteSettingIsBilingual($kind) ? [$old['edited'] ? $old['ta'] : null, $old['edited'] ? $old['en'] : null] : [$old['edited'] ? $old['value'] : null];
        $next = siteSettingIsBilingual($kind) ? [$ta, $en] : [$v];
        $stmt->execute([':k' => $key, ':ta' => $ta, ':en' => $en, ':v' => $v, ':by' => $actor !== null ? mb_substr($actor, 0, 60) : null]);
        if ($prev !== $next) $changed[] = $key;
    }
    siteSettingsAll(true);
    return $changed;
}

/** Active SEO overrides: path => ['title_ta','title_en','description_ta','description_en','og_image','noindex']. */
function siteSeoOverrides(): array
{
    static $cache = null;
    if ($cache !== null) return $cache;
    $out = [];
    try {
        $db = getDB();
        $db->query('SELECT 1 FROM seo_settings LIMIT 0')->closeCursor();
        foreach ($db->query('SELECT path, title_ta, title_en, description_ta, description_en, og_image, noindex FROM seo_settings WHERE is_active = 1')->fetchAll() as $r) {
            $out[(string) $r['path']] = [
                'title_ta' => $r['title_ta'], 'title_en' => $r['title_en'],
                'description_ta' => $r['description_ta'], 'description_en' => $r['description_en'],
                'og_image' => $r['og_image'], 'noindex' => (bool) $r['noindex'],
            ];
        }
    } catch (Throwable) {
        // migration 025 not applied
    }
    return $cache = $out;
}

/** The languages the site offers and the one a first visit opens in. */
function siteLanguages(): array
{
    $enabled = array_values(array_filter(array_map('trim', explode(',', (string) siteSetting('languages_enabled'))), static fn($c) => in_array($c, ['ta', 'en'], true)));
    if ($enabled === []) $enabled = ['ta', 'en'];
    $default = (string) siteSetting('language_default');
    if (!in_array($default, $enabled, true)) $default = $enabled[0];
    return ['enabled' => $enabled, 'default' => $default];
}
