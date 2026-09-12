<?php
/**
 * backend/admin/includes/admin_ui.php — server-rendered UI helpers for the
 * Temple Admin control center. Every helper returns HTML built ONLY from the
 * shared design-system classes (backend/admin/assets/ds/*.css, generated from
 * frontend/src/styles) plus the admin shell classes in assets/admin.css.
 *
 * Helpers:
 *   adminIcon($name, $class)               inline Lucide SVG
 *   adminBadge($text, $tone, $live)        .badge
 *   adminKpi(array $items)                 KPI grid of .stat cards
 *   adminEmpty($icon, $title, $desc, $actionHtml)
 *   adminPageIntro($desc, $actionsHtml)    lead paragraph + action row under the topbar
 *   adminMenu(array $items, $label)        "⋯" context menu (client behaviour in admin.js)
 *   adminPagination($page, $pages, array $query, $total, $perPage)
 *   adminSortLink($col, $label, array $query)
 *   adminPaginate(PDO $db, $sql, $params, $page, $perPage, $countSql)
 *   adminBars(array $series, $label)       accessible CSS bar chart
 *   adminCsrfGuard()                       validates POST + returns error alert HTML or ''
 *   adminFmtDate / adminFmtMoney / adminAgo formatting
 *   h($s)                                  htmlspecialchars shorthand
 */

function h(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

/** Inline Lucide icons (stroke, 24 viewBox). Unknown names render a dot. */
function adminIcon(string $name, string $class = ''): string
{
    static $paths = [
        'dashboard'    => '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
        'megaphone'    => '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
        'image'        => '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
        'flame'        => '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
        'calendar'     => '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>',
        'heart-hands'  => '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M12 5 9.04 7.96a2.17 2.17 0 0 0 0 3.08c.82.82 2.13.85 3 .07l2.07-1.9a2.82 2.82 0 0 1 3.79 0l2.96 2.66"/><path d="m18 15-2-2"/><path d="m15 18-2-2"/>',
        'clipboard'    => '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
        'banknote'     => '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
        'mail'         => '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
        'upload'       => '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
        'download'     => '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
        'settings'     => '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        'search'       => '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        'menu'         => '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
        'x'            => '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        'chevron-down' => '<path d="m6 9 6 6 6-6"/>',
        'chevron-right'=> '<path d="m9 18 6-6-6-6"/>',
        'chevron-left' => '<path d="m15 18-6-6 6-6"/>',
        'chevrons-left'=> '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
        'chevrons-right'=> '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>',
        'chevron-up'   => '<path d="m18 15-6-6-6 6"/>',
        'external'     => '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        'logout'       => '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
        'user'         => '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        'users'        => '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        'plus'         => '<path d="M5 12h14"/><path d="M12 5v14"/>',
        'trash'        => '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
        'pencil'       => '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        'check'        => '<path d="M20 6 9 17l-5-5"/>',
        'check-circle' => '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        'alert'        => '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        'alert-circle' => '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
        'info'         => '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
        'filter'       => '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
        'more'         => '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
        'arrow-up-right'=> '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
        'arrow-left'   => '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
        'arrow-right'  => '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
        'moon'         => '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        'sun'          => '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
        'sparkles'     => '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
        'eye'          => '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
        'eye-off'      => '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
        'lock'         => '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        'key'          => '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
        'bell'         => '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        'copy'         => '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        'refresh'      => '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
        'house'        => '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        'table'        => '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
        'landmark'     => '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
        'activity'     => '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
        'trending'     => '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
        'clock'        => '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        'spreadsheet'  => '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
        'panel'        => '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
        'command'      => '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
        'inbox'        => '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        'pin'          => '<line x1="12" x2="12" y1="17" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
        'gift'         => '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
        'shield'       => '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
        'layers'       => '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
        'phone'        => '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
        'toggle'       => '<rect width="20" height="12" x="2" y="6" rx="6" ry="6"/><circle cx="16" cy="12" r="2"/>',
        'list-checks'  => '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
        'dot'          => '<circle cx="12" cy="12" r="3"/>',
    ];
    $d = $paths[$name] ?? $paths['dot'];
    $cls = trim('ico ' . $class);
    return '<svg class="' . h($cls) . '" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' . $d . '</svg>';
}

/** .badge with an optional tone (gold|success|warning|danger|info|moon|sage|muted) */
function adminBadge(string $text, string $tone = '', bool $live = false): string
{
    $cls = 'badge' . ($tone ? " badge--$tone" : '') . ($live ? ' badge--live' : '');
    return '<span class="' . $cls . '">' . h($text) . '</span>';
}

/** Map a booking status to a badge tone. */
function adminStatusTone(string $status): string
{
    return ['pending' => 'warning', 'confirmed' => 'info', 'completed' => 'success', 'cancelled' => 'danger'][$status] ?? 'muted';
}

/**
 * KPI grid. Each item: ['label','value','icon','href'=>null,'variant'=>''|'accent','delta'=>null,'deltaDown'=>false,'sub'=>null]
 */
function adminKpi(array $items): string
{
    $out = '<div class="stats-grid" aria-label="Key metrics">';
    foreach ($items as $i => $it) {
        $tag   = !empty($it['href']) ? 'a' : 'div';
        $href  = !empty($it['href']) ? ' href="' . h($it['href']) . '"' : '';
        $cls   = 'card card--static stat' . (($it['variant'] ?? '') === 'accent' ? ' stat--accent' : '') . (!empty($it['href']) ? ' stat--link' : '');
        $out  .= "<$tag class=\"$cls rise\" style=\"--i:$i\"$href>";
        $out  .= '<span class="stat__icon">' . adminIcon($it['icon'] ?? 'dot') . '</span>';
        $out  .= '<div class="stat__body"><div class="stat__val">' . h((string) $it['value']) . '</div>';
        $out  .= '<div class="stat__label">' . h($it['label']) . '</div>';
        if (isset($it['delta'])) {
            $down = !empty($it['deltaDown']);
            $out .= '<div class="stat__delta' . ($down ? ' stat__delta--down' : '') . '">' . adminIcon($down ? 'chevron-down' : 'trending', 'ico--xs') . h((string) $it['delta']) . '</div>';
        } elseif (!empty($it['sub'])) {
            $out .= '<div class="stat__sub">' . h($it['sub']) . '</div>';
        }
        $out  .= '</div>';
        if (!empty($it['href'])) {
            $out .= '<span class="stat__arrow">' . adminIcon('arrow-up-right', 'ico--sm') . '</span>';
        }
        $out  .= "</$tag>";
    }
    return $out . '</div>';
}

function adminEmpty(string $icon, string $title, string $desc = '', string $actionHtml = '', bool $compact = false): string
{
    $out  = '<div class="empty-state' . ($compact ? ' empty-state--compact' : '') . '" role="status">';
    $out .= '<span class="empty-state__icon">' . adminIcon($icon) . '</span>';
    $out .= '<h3 class="empty-state__title">' . h($title) . '</h3>';
    if ($desc !== '')       $out .= '<p>' . h($desc) . '</p>';
    if ($actionHtml !== '') $out .= '<div class="empty-state__actions">' . $actionHtml . '</div>';
    return $out . '</div>';
}

/** Lead paragraph + action row shown under the topbar on every page. */
function adminPageIntro(string $desc = '', string $actionsHtml = ''): string
{
    if ($desc === '' && $actionsHtml === '') return '';
    $out = '<div class="page-intro">';
    if ($desc !== '')        $out .= '<p class="page-intro__desc">' . h($desc) . '</p>';
    if ($actionsHtml !== '') $out .= '<div class="page-intro__actions">' . $actionsHtml . '</div>';
    return $out . '</div>';
}

/**
 * "⋯" context menu. Items: ['label','href'|'formAction'=>['action'=>..,'id'=>..],'icon','danger'=>bool,'confirm'=>'message']
 * Form items render as tiny POST forms (CSRF-protected) so no JS is needed to act.
 */
function adminMenu(array $items, string $label = 'Actions'): string
{
    static $n = 0;
    $id  = 'menu-' . (++$n);
    $out = '<div class="dropdown row-menu">';
    $out .= '<button type="button" class="btn btn-ghost btn--icon btn--sm" aria-haspopup="menu" aria-expanded="false" aria-controls="' . $id . '" aria-label="' . h($label) . '" data-menu-toggle>' . adminIcon('more') . '</button>';
    $out .= '<div class="menu" id="' . $id . '" role="menu" hidden>';
    foreach ($items as $it) {
        if ($it === 'divider') { $out .= '<div class="menu__divider" role="separator"></div>'; continue; }
        $cls = 'menu__item' . (!empty($it['danger']) ? ' menu__item--danger' : '');
        $ico = !empty($it['icon']) ? adminIcon($it['icon']) : '';
        if (!empty($it['href'])) {
            $out .= '<a class="' . $cls . '" role="menuitem" href="' . h($it['href']) . '">' . $ico . h($it['label']) . '</a>';
        } elseif (!empty($it['form'])) {
            $out .= '<form method="POST" class="menu__form"' . (!empty($it['action']) ? ' action="' . h($it['action']) . '"' : '') . '>' . csrfField();
            foreach ($it['form'] as $k => $v) {
                $out .= '<input type="hidden" name="' . h($k) . '" value="' . h((string) $v) . '" />';
            }
            $confirm = !empty($it['confirm']) ? ' data-confirm="' . h($it['confirm']) . '" data-confirm-label="' . h($it['confirmLabel'] ?? $it['label']) . '"' : '';
            $out .= '<button type="submit" class="' . $cls . '" role="menuitem"' . $confirm . '>' . $ico . h($it['label']) . '</button></form>';
        }
    }
    return $out . '</div></div>';
}

/** Build a query string preserving current filters, overriding some keys. */
function adminQuery(array $query, array $override = []): string
{
    $q = array_filter(array_merge($query, $override), fn($v) => $v !== null && $v !== '');
    return $q ? '?' . http_build_query($q) : '?';
}

/** Pagination bar (page/pages are 1-based). */
function adminPagination(int $page, int $pages, array $query, int $total = 0, int $perPage = 25): string
{
    if ($pages <= 1 && $total <= $perPage) {
        return $total ? '<div class="pagination"><span>' . $total . ' record' . ($total === 1 ? '' : 's') . '</span></div>' : '';
    }
    $from = ($page - 1) * $perPage + 1;
    $to   = min($total, $page * $perPage);
    $out  = '<nav class="pagination" aria-label="Pagination"><span>Showing ' . $from . '–' . $to . ' of ' . $total . '</span><div class="pagination__pages">';
    $link = function (int $p, string $label, string $aria, bool $disabled = false, bool $current = false) use ($query) {
        if ($disabled) return '<span class="pagination__btn" aria-disabled="true">' . $label . '</span>';
        $cur = $current ? ' aria-current="page"' : '';
        return '<a class="pagination__btn" href="' . h(adminQuery($query, ['page' => $p])) . '" aria-label="' . h($aria) . '"' . $cur . '>' . $label . '</a>';
    };
    $out .= $link($page - 1, adminIcon('chevron-left'), 'Previous page', $page <= 1);
    $window = [];
    foreach ([1, 2, $page - 1, $page, $page + 1, $pages - 1, $pages] as $p) {
        if ($p >= 1 && $p <= $pages) $window[$p] = true;
    }
    $prev = 0;
    foreach (array_keys($window) as $p) {
        if ($prev && $p - $prev > 1) $out .= '<span class="pagination__ellipsis">…</span>';
        $out .= $link($p, (string) $p, "Page $p", false, $p === $page);
        $prev = $p;
    }
    $out .= $link($page + 1, adminIcon('chevron-right'), 'Next page', $page >= $pages);
    return $out . '</div></nav>';
}

/** Sortable column header link; $query must contain 'sort' and 'dir'. */
function adminSortLink(string $col, string $label, array $query): string
{
    $active = ($query['sort'] ?? '') === $col;
    $dir    = $active && ($query['dir'] ?? 'asc') === 'asc' ? 'desc' : 'asc';
    $aria   = $active ? ' aria-sort="' . (($query['dir'] ?? 'asc') === 'asc' ? 'ascending' : 'descending') . '"' : '';
    $icon   = $active ? adminIcon(($query['dir'] ?? 'asc') === 'asc' ? 'chevron-up' : 'chevron-down', 'ico--xs') : adminIcon('chevron-down', 'ico--xs ico--faint');
    return '<th class="is-sortable" scope="col"' . $aria . '><a href="' . h(adminQuery($query, ['sort' => $col, 'dir' => $dir, 'page' => 1])) . '">' . h($label) . $icon . '</a></th>';
}

/**
 * Run a paginated query. $sql is the SELECT without LIMIT; $countSql defaults
 * to a COUNT(*) wrapper. Returns ['rows','total','pages','page'].
 */
function adminPaginate(PDO $db, string $sql, array $params, int $page, int $perPage = 25, ?string $countSql = null): array
{
    $page = max(1, $page);
    $countSql ??= 'SELECT COUNT(*) FROM (' . $sql . ') AS t';
    $stmt = $db->prepare($countSql);
    $stmt->execute($params);
    $total = (int) $stmt->fetchColumn();
    $pages = max(1, (int) ceil($total / $perPage));
    $page  = min($page, $pages);
    $stmt  = $db->prepare($sql . ' LIMIT ' . (int) $perPage . ' OFFSET ' . (int) (($page - 1) * $perPage));
    $stmt->execute($params);
    return ['rows' => $stmt->fetchAll(), 'total' => $total, 'pages' => $pages, 'page' => $page];
}

/**
 * Accessible CSS bar chart. $series = [['label'=>'Jan','value'=>1200,'hint'=>'₹1,200'], …]
 * Renders a <figure> with bars sized by --v (0..1) and a screen-reader table.
 */
function adminBars(array $series, string $label, string $tone = 'gold'): string
{
    $max = 0.0;
    foreach ($series as $s) $max = max($max, (float) $s['value']);
    $out  = '<figure class="bars bars--' . h($tone) . '" aria-label="' . h($label) . '">';
    $out .= '<div class="bars__plot" aria-hidden="true">';
    foreach ($series as $s) {
        $v = $max > 0 ? round((float) $s['value'] / $max, 3) : 0;
        $out .= '<div class="bars__col"><div class="bars__bar" style="--v:' . $v . '" data-tip="' . h($s['hint'] ?? (string) $s['value']) . '"></div><span class="bars__label">' . h($s['label']) . '</span></div>';
    }
    $out .= '</div><table class="sr-only"><caption>' . h($label) . '</caption><thead><tr><th>Period</th><th>Value</th></tr></thead><tbody>';
    foreach ($series as $s) $out .= '<tr><td>' . h($s['label']) . '</td><td>' . h($s['hint'] ?? (string) $s['value']) . '</td></tr>';
    return $out . '</tbody></table></figure>';
}

/** Horizontal share bars: [['label','value','tone'=>'gold|moon|sage|info|danger']] */
function adminShares(array $items, string $label): string
{
    $total = 0.0;
    foreach ($items as $it) $total += (float) $it['value'];
    $out = '<ul class="shares" role="list" aria-label="' . h($label) . '">';
    foreach ($items as $it) {
        $pct = $total > 0 ? round((float) $it['value'] / $total * 100) : 0;
        $out .= '<li class="shares__row"><span class="shares__label">' . h($it['label']) . '</span>';
        $out .= '<span class="shares__track"><span class="shares__fill shares__fill--' . h($it['tone'] ?? 'gold') . '" style="--v:' . ($pct / 100) . '"></span></span>';
        $out .= '<span class="shares__val">' . h($it['hint'] ?? ((string) $it['value'])) . ' <small>' . $pct . '%</small></span></li>';
    }
    return $out . '</ul>';
}

/** Validate CSRF on POST; returns an error alert (HTML) when invalid, '' when fine. */
function adminCsrfGuard(): string
{
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && !csrfValid()) {
        return '<p class="alert alert--error">Your session expired or the form was tampered with. Please reload and try again.</p>';
    }
    return '';
}

function adminFmtMoney(float $n, int $dec = 0): string
{
    return '₹' . number_format($n, $dec);
}

function adminFmtDate(?string $iso, bool $withTime = false): string
{
    if (!$iso) return '—';
    try {
        $d = new DateTime($iso);
        return $d->format($withTime ? 'd M Y · H:i' : 'd M Y');
    } catch (Throwable) {
        return $iso;
    }
}

/** "3 hours ago" style helper for activity feeds. */
function adminAgo(?string $iso): string
{
    if (!$iso) return '';
    $t = strtotime($iso);
    if (!$t) return $iso;
    $diff = time() - $t;
    if ($diff < 60) return 'just now';
    if ($diff < 3600) return floor($diff / 60) . ' min ago';
    if ($diff < 86400) return floor($diff / 3600) . ' h ago';
    if ($diff < 86400 * 7) return floor($diff / 86400) . ' d ago';
    return date('d M Y', $t);
}
