<?php
/**
 * backend/includes/payments.php — loads the online payments module
 * (docs/payments/SPEC.md §5.1).
 *
 * Everything about CCAvenue, payables (online donations and online seva
 * bookings), attempts, receipts, refunds and reconciliation lives in
 * backend/includes/payments/, which the web server never serves directly
 * (backend/includes/.htaccess). API files and admin pages require this one file
 * and call the library; they hold no payment logic of their own.
 *
 * Loading costs a handful of function definitions and no database query. The
 * notification service itself loads only when a message is about to be sent
 * (devotee_notify.php).
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/public_guard.php';
require_once __DIR__ . '/rate_limit.php';
require_once __DIR__ . '/notify/contracts.php';   // notifyHttp(), notifyRedact(), notifyB64u()
require_once __DIR__ . '/devotee_notify.php';     // devoteeNotifyEvent(), devoteeIntlPhone(), devoteeLangFromInput()

foreach ([
    'money',
    'numbers',
    'config',
    'audit',
    'categories',
    'validate',
    'ccavenue',
    'store',
    'notify',
    'receipt',
    'refunds',
    'reconcile',
    'response',
    'simulator',
    'admin',
] as $payModule) {
    require_once __DIR__ . '/payments/' . $payModule . '.php';
}
unset($payModule);
