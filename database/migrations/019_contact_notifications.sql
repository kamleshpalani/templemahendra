-- 019_contact_notifications.sql — the temple office is told about every
-- message sent through the website's contact form (brief §20, E2E-040;
-- docs/GAP-ANALYSIS.md G-19).
--
-- api/contact.php raises the contact.received event for each address in
-- CONTACT_NOTIFY_EMAIL. Its template is filed under a category of its own,
-- "office": transactional, so the channel policy sends it without asking for
-- a devotee's consent (the recipient is the committee, not a family), and it
-- can never be chosen for a campaign (the composer refuses transactional
-- categories). Idempotent: INSERT IGNORE on the primary key.
--
-- Always apply with --default-character-set=utf8mb4.

INSERT IGNORE INTO `notification_categories`
  (`key`, `label_ta`, `label_en`, `icon`, `kind`, `default_on`, `sort_order`)
VALUES
  ('office', 'கோயில் அலுவலகம்', 'Temple office', 'inbox', 'transactional', 1, 125);
