CREATE TABLE IF NOT EXISTS live_stream_subscriptions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    live_stream_id INT UNSIGNED NOT NULL,
    email VARCHAR(190) NOT NULL,
    lang VARCHAR(8) NOT NULL DEFAULT 'ta',
    consent_at DATETIME NOT NULL,
    unsubscribed_at DATETIME NULL,
    reminded_start_at DATETIME NULL,
    UNIQUE KEY uniq_stream_email (live_stream_id, email),
    KEY idx_live_subscription_active (unsubscribed_at, live_stream_id),
    CONSTRAINT fk_live_subscription_stream FOREIGN KEY (live_stream_id)
        REFERENCES live_streams (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO notification_categories
    (`key`, label_ta, label_en, icon, kind, default_on, sort_order)
VALUES
    ('live_reminders', 'நேரடி தரிசன நினைவூட்டல்கள்', 'Live darshan reminders',
     'bell', 'informational', 0, 65);
