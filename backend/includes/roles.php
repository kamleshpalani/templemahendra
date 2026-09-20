<?php
// backend/includes/roles.php — the admin role model, with no session or
// database dependency so workers and unit tests can load it on its own.
//
// Roles (database value → what the committee calls it):
//   owner    Super Admin      everything, including accounts, credentials and settings
//   admin    Temple Admin     day-to-day running of the temple: content, finance,
//                             notifications and live streams, but not accounts or
//                             provider/merchant credentials
//   editor   Content Editor   content, bookings, imports, live streams, small notifications
//   finance  Finance Admin    donations, payments, refunds, sponsors and receipts
//   viewer   Viewer           read-only, with CSV exports
//
// A capability is granted to a role by listing it in ADMIN_ROLE_GRANTS; there is
// no implied hierarchy, so a finance admin can refund money without being able
// to edit the homepage, and vice versa.

const ADMIN_ROLES = ['viewer', 'finance', 'editor', 'admin', 'owner'];

const ADMIN_ROLE_LABELS = [
    'owner'   => 'Super Admin — full access, can manage accounts, credentials and settings',
    'admin'   => 'Temple Admin — content, finance, notifications and live streams (no accounts or credentials)',
    'editor'  => 'Content Editor — manage content, bookings, imports and live streams',
    'finance' => 'Finance Admin — donations, payments, refunds, sponsors and receipts',
    'viewer'  => 'Viewer — read-only access and CSV exports',
];

const ADMIN_ROLE_SHORT = [
    'owner' => 'Super Admin', 'admin' => 'Temple Admin', 'editor' => 'Content Editor',
    'finance' => 'Finance Admin', 'viewer' => 'Viewer',
];

/** Capability → roles that hold it. Anything unlisted is the owner's alone. */
const ADMIN_ROLE_GRANTS = [
    'view'          => ['viewer', 'finance', 'editor', 'admin', 'owner'],
    'export'        => ['viewer', 'finance', 'editor', 'admin', 'owner'],
    'content.edit'  => ['editor', 'admin', 'owner'],   // sevas, events, announcements, poojas, gallery, widgets, deities
    'devotees.edit' => ['editor', 'admin', 'owner'],   // booking status, delete messages
    'import'        => ['editor', 'admin', 'owner'],   // bulk upload
    'finance.edit'  => ['finance', 'editor', 'admin', 'owner'],  // donations, sponsors, donation categories, receipts
    'settings.edit' => ['admin', 'owner'],             // homepage settings
    'users.manage'  => ['owner'],                      // committee accounts and roles
    'audit.view'    => ['admin', 'owner'],             // the audit log page

    // Devotee notifications (docs/notifications/SPEC.md §8.1). Approval of a
    // large broadcast cannot be taken back, so it stays with the temple's admins.
    'notifications.view'      => ['viewer', 'finance', 'editor', 'admin', 'owner'],
    'notifications.compose'   => ['editor', 'admin', 'owner'],
    'notifications.approve'   => ['admin', 'owner'],
    'notifications.templates' => ['admin', 'owner'],

    // Online payments (docs/payments/SPEC.md §10.1). The merchant account's
    // keys are the owner's alone; sending money back is finance's work.
    'payments.view'     => ['viewer', 'finance', 'editor', 'admin', 'owner'],
    'payments.manage'   => ['finance', 'editor', 'admin', 'owner'],
    'payments.refund'   => ['finance', 'admin', 'owner'],
    'payments.settings' => ['owner'],

    // Live darshan (docs/live/SPEC-PHASE1.md §4.5).
    'live.view'      => ['viewer', 'finance', 'editor', 'admin', 'owner'],
    'live.manage'    => ['editor', 'admin', 'owner'],
    'live.publish'   => ['editor', 'admin', 'owner'],
    'live.provider'  => ['owner'],
    'live.analytics' => ['viewer', 'finance', 'editor', 'admin', 'owner'],
];

const ADMIN_ROLE_TONE = ['owner' => 'gold', 'admin' => 'warning', 'editor' => 'info', 'finance' => 'success', 'viewer' => 'muted'];

/** Human label for a stored role value. */
function adminRoleLabel(?string $role): string
{
    return ADMIN_ROLE_SHORT[adminNormalizeRole($role)];
}

function adminRoleTone(?string $role): string
{
    return ADMIN_ROLE_TONE[adminNormalizeRole($role)];
}

/** A stored role value, or 'viewer' for anything unknown (least privilege). */
function adminNormalizeRole(?string $role): string
{
    return in_array($role, ADMIN_ROLES, true) ? $role : 'viewer';
}

/** Does this role hold this capability? Pure: no session, no database. */
function adminRoleCan(?string $role, string $capability): bool
{
    $role = adminNormalizeRole($role);
    if ($role === 'owner') return true;
    return in_array($role, ADMIN_ROLE_GRANTS[$capability] ?? [], true);
}
