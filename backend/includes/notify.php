<?php
/**
 * backend/includes/notify.php — the Notification Service. The one file every
 * caller requires:
 *
 *   require_once __DIR__ . '/../includes/notify.php';
 *   notifyEvent('booking.confirmed', ['devotee_id' => $id, 'entity_id' => $bookingId, 'vars' => [...]]);
 *
 * Requiring it only defines functions, constants and classes: no session is
 * started, nothing is printed, no query runs. That matters because it is loaded
 * by public API endpoints, the admin, the cron worker and CLI tests alike.
 *
 * docs/notifications/SPEC.md is the contract. The pieces:
 *
 *   notify/contracts.php   provider interface, message and result, drivers
 *   notify/defaults.php    built-in wording and the temple's facts
 *   notify/templates.php   template lookup and rendering
 *   notify/email.php       the branded HTML email and its plain-text twin
 *   notify/time.php        UTC clock, time zones, secret, languages, internal settings
 *   notify/categories.php  categories and their kinds
 *   notify/prefs.php       devotee preferences
 *   notify/policy.php      which channels a message may use
 *   notify/tracking.php    signed links, opens, clicks, unsubscribe
 *   notify/service.php     notify()
 *   notify/events.php      the automated events catalogue, notifyEvent()
 *   notify/queue.php       dispatch, the worker, provider callbacks
 *   notify/audience.php    campaign audiences as SQL
 *   notify/campaigns.php   campaigns, approval, expansion, previews
 *   notify/reminders.php   evening-before reminders
 *   notify/devices.php     push subscriptions, VAPID keys
 *   notify/otp.php         one-time codes for mobile verification
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

require_once __DIR__ . '/notify/contracts.php';
require_once __DIR__ . '/notify/defaults.php';
require_once __DIR__ . '/notify/templates.php';
require_once __DIR__ . '/notify/email.php';

require_once __DIR__ . '/notify/time.php';
require_once __DIR__ . '/notify/categories.php';
require_once __DIR__ . '/notify/prefs.php';
require_once __DIR__ . '/notify/policy.php';
require_once __DIR__ . '/notify/tracking.php';
require_once __DIR__ . '/notify/service.php';
require_once __DIR__ . '/notify/events.php';
require_once __DIR__ . '/notify/queue.php';
require_once __DIR__ . '/notify/audience.php';
require_once __DIR__ . '/notify/campaigns.php';
require_once __DIR__ . '/notify/reminders.php';
require_once __DIR__ . '/notify/devices.php';
require_once __DIR__ . '/notify/otp.php';
