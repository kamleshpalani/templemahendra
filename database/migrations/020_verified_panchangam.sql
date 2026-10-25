-- Daily values transcribed and verified by the committee for Pudupatti, IST.
CREATE TABLE IF NOT EXISTS panchangam_days (
  calendar_date DATE PRIMARY KEY,
  tithi_ta VARCHAR(100) NOT NULL,
  tithi_en VARCHAR(100) NOT NULL,
  nakshatram_ta VARCHAR(100) NOT NULL,
  nakshatram_en VARCHAR(100) NOT NULL,
  timings JSON NOT NULL,
  source VARCHAR(500) NOT NULL,
  location VARCHAR(200) NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
