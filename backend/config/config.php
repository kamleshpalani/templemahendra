<?php
// backend/config/config.php

define('SITE_NAME', 'Sri Mahendra Temple');
define('UPLOAD_DIR', __DIR__ . '/../uploads/');
define('UPLOAD_MAX_MB', 5);
define('ALLOWED_IMAGE_TYPES', ['image/jpeg', 'image/png', 'image/webp']);

// CORS — restrict to your domain in production
define('CORS_ORIGIN', getenv('CORS_ORIGIN') ?: '*');

// ── AI Chatbot ────────────────────────────────────────────────────────
// Set GEMINI_API_KEY in your Hostinger environment variables (or .env)
// to enable Google Gemini AI responses. Leave empty for rule-based fallback.
// Get a free key at: https://aistudio.google.com/app/apikey
// On Hostinger: hPanel → Hosting → Manage → PHP → Environment Variables
//   Key:   GEMINI_API_KEY
//   Value: AIza...your-key...

