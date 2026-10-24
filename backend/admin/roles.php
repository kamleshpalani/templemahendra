<?php
// backend/admin/roles.php — System → Roles: what each committee role may do
// (brief §15, §17). Read-only: the capability matrix is ADMIN_ROLE_GRANTS in
// backend/includes/roles.php, enforced server-side by requireAdminAuth(); this
// page shows it so nobody has to read PHP to know who can do what.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/includes/admin_layout.php';

$capabilities = [
    'view'                    => 'Open the admin, read lists and dashboards',
    'export'                  => 'Download CSV exports',
    'content.edit'            => 'Homepage cards, pages, announcements, poojas, sevas, events, calendar, deities, gallery, videos',
    'devotees.edit'           => 'Seva booking status, delete contact messages',
    'import'                  => 'Bulk upload CSV / Excel',
    'finance.edit'            => 'Donations, sponsors, donation categories',
    'settings.edit'           => 'Site settings, languages, SEO overrides, homepage sections',
    'users.manage'            => 'Committee accounts and their roles',
    'audit.view'              => 'The audit log',
    'notifications.view'      => 'Read campaigns, templates, audiences, analytics',
    'notifications.compose'   => 'Compose, submit and send small campaigns',
    'notifications.approve'   => 'Approve large broadcasts',
    'notifications.templates' => 'Change message wording',
    'payments.view'           => 'Read online payments and receipts',
    'payments.manage'         => 'Resend receipts, mark reviewed, reconciliation',
    'payments.refund'         => 'Refund online payments',
    'payments.settings'       => 'CCAvenue credentials and mode',
    'live.view'               => 'Read live streams',
    'live.manage'             => 'Create, edit, delete live streams',
    'live.publish'            => 'Publish, go live, end a stream',
    'live.provider'           => 'YouTube credentials and automation',
    'live.analytics'          => 'Live health and viewer figures',
];

adminHeader('Roles', 'System', ['actions' => adminCan('users.manage') ? '<a href="/admin/users.php" class="btn btn--sm">' . adminIcon('users') . 'Users</a>' : '']);
echo adminPageIntro('Every role holds exactly the capabilities ticked below — there is no hierarchy, and the server checks the capability for reading a page and again for changing it, so hiding a button is never the only guard. The environment account is always a Super Admin.');
?>
<section class="card card--static" aria-labelledby="roles-title">
  <div class="card__head"><h2 id="roles-title"><?= adminIcon('shield', 'ico--sm') ?> Capability matrix</h2></div>
  <div class="table-wrap">
    <table class="table" data-no-search>
      <thead>
        <tr>
          <th scope="col">Capability</th>
          <?php foreach (ADMIN_ROLES as $role): ?>
            <th scope="col"><?= adminBadge(adminRoleLabel($role), adminRoleTone($role)) ?></th>
          <?php endforeach; ?>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($capabilities as $cap => $what): ?>
          <tr>
            <th scope="row"><code><?= h($cap) ?></code><span class="cell-sub"><?= h($what) ?></span></th>
            <?php foreach (ADMIN_ROLES as $role): $has = adminRoleCan($role, $cap); ?>
              <td class="num"><?= $has ? adminIcon('check', 'ico--sm') . '<span class="sr-only">yes</span>' : '<span class="text-muted" aria-label="no">—</span>' ?></td>
            <?php endforeach; ?>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <div class="callout mt-4"><?= adminIcon('info') ?><p>Roles are fixed in code (<code>backend/includes/roles.php</code>) so that a mistake in the database can never widen anyone's access; changing a grant is a reviewed code change. Accounts and their roles are managed under <a href="/admin/users.php">Users</a>.</p></div>
</section>
<?php adminFooter(); ?>
