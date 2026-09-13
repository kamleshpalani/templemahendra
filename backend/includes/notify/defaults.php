<?php
/**
 * backend/includes/notify/defaults.php — the built-in wording of every
 * notification, and the temple facts the wording leans on.
 *
 * These are the words a devotee receives until the committee edits them in
 * Admin → Message Templates (rows in `notification_templates` win; see
 * templates.php for the resolution order). Every key ships Tamil and English,
 * a shared version ("any": the bell, push, email) and two channel overrides:
 *
 *   sms       One segment wherever it can be. English stays within 160 GSM-7
 *             characters with realistic values (tests/notify-templates-unit.php
 *             checks it), so no curly quotes, dashes or ₹ — each would switch
 *             the whole message to UCS-2 and halve its room. Tamil is always
 *             UCS-2 (70 per segment), so it says only what cannot wait.
 *   whatsapp  The same message with *bold* labels, which WhatsApp renders.
 *
 * Voice: warm, respectful and plain. Tamil uses the site's own words (சேவை
 * பதிவு, நன்கொடை, கோயில் அலுவலகம், உறுதிப்படுத்து); English is plain Indian
 * English and greets with "Vanakkam", as the site's emails always have.
 * Titles carry no personal names: they appear on lock screens.
 *
 * Security messages say what happened and what to do if it was not the
 * devotee. Links that prove something (verify an email, reset a password) are
 * written only into the email body, on a line of their own — never into SMS or
 * WhatsApp: a phone is not proof of owning an email address, and a reset link
 * sent to an unverified number would hand the account to whoever holds it.
 */

/**
 * Facts about the temple, copied from frontend/src/data/temple.js (TEMPLE,
 * ADDRESS, MAPS_URL, TRUST, COMMITTEE). That file is the source of truth: when
 * the committee changes a name, address or phone number there, change it here
 * too. The PHP side cannot read the JavaScript module at runtime on shared
 * hosting, which is why this is a copy and not an import.
 *
 * "shortName" is not in temple.js: an SMS cannot spend 50 of its 160
 * characters on the full name, and the village is how devotees tell this temple
 * from every other Renukadevi temple.
 */
function notifyTempleFacts(): array
{
    static $facts = null;
    if ($facts !== null) return $facts;

    // ADDRESS.mapsQuery, encoded as encodeURIComponent does (letters, digits, commas and spaces only).
    $mapsQuery = 'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple, Middle Street, Pudupatti, Thiruvengadam Taluk, Tenkasi District, Tamil Nadu 627719';

    return $facts = [
        'name' => [
            'ta' => 'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
            'en' => 'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple',
        ],
        'shortName' => [
            'ta' => 'புதுப்பட்டி திருக்கோவில்',
            'en' => 'Pudupatti Temple',
        ],
        'descriptor' => [
            'ta' => 'தப்பலவார் குலதெய்வம்',
            'en' => 'Dhabbalavaar Kula Deivam',
        ],
        'address' => [
            'ta' => 'நடு தெரு, புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம், தமிழ்நாடு - 627719',
            'en' => 'Middle Street, Pudupatti, Thiruvengadam Taluk, Tenkasi District, Tamil Nadu – 627719',
        ],
        'mapsUrl' => 'https://maps.google.com/maps?q=' . rawurlencode($mapsQuery),
        // COMMITTEE.members[0] (President) is PRIMARY_CONTACT, the number every
        // "Call" button on the site dials; members[2] (Secretary) is SECONDARY_CONTACT.
        'phones' => [
            'primary'   => '+919443002296',
            'secondary' => '+917373016302',
        ],
        'phoneDisplay' => [
            'primary'   => '+91 94430 02296',
            'secondary' => '+91 73730 16302',
        ],
        'supportPhone'        => '+919443002296',
        'supportPhoneDisplay' => '+91 94430 02296',
        'trust' => [
            'ta' => 'அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை',
            'en' => 'Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust',
        ],
        // TRUST.taxExemption.long with the printed exemption number and PAN (TRUST.registration).
        'taxNote' => [
            'ta' => "80G வருமான வரிச்சலுகை: நன்கொடையாளர்கள் வருமான வரி சலுகை பெற வருமான வரித்துறையிலிருந்து உத்தரவு பெறப்பட்டுள்ளது. வருமான வரிச்சலுகை எண்: A12A IV SUB SECTION (5) OF 80'G. அறக்கட்டளை பான் எண்: AAKTA2241H.",
            'en' => "80G income-tax exemption: an order has been obtained from the Income Tax Department so that donors receive income-tax exemption. Income Tax Exemption No.: A12A IV SUB SECTION (5) OF 80'G. Trust PAN: AAKTA2241H.",
        ],
        'taxShort' => [
            'ta' => '80G வருமான வரிச்சலுகை',
            'en' => '80G income-tax exemption',
        ],
        'registrationNo' => '9/2023',
    ];
}

/**
 * Templates added at runtime by a module that ships its own messages (a future
 * volunteer or payments module), without editing this file. Built-in keys
 * cannot be replaced this way — the committee changes those in the admin.
 *
 * $definition has the same shape as a notifyTemplateDefaults() entry. Returns
 * false when the key is malformed or built in.
 */
function notifyTemplateRegister(string $key, array $definition): bool
{
    if (!preg_match('/^[a-z0-9_]{1,64}$/', $key) || isset(notifyTemplateBuiltIn()[$key])) return false;
    notifyTemplateRegistered([$key => $definition]);
    return true;
}

/** The runtime-registered templates; passing an array adds to them. */
function notifyTemplateRegistered(?array $add = null): array
{
    static $extra = [];
    if ($add !== null) $extra = $add + $extra;
    return $extra;
}

/**
 * Every template key with its category, an English description for the admin,
 * its variables, its default call-to-action path and its wording. See
 * docs/notifications/SPEC.md §5.2 for the shape.
 */
function notifyTemplateDefaults(): array
{
    return notifyTemplateBuiltIn() + notifyTemplateRegistered();
}

function notifyTemplateBuiltIn(): array
{
    static $t = null;
    if ($t !== null) return $t;

    $signTa = "அன்புடன்,\nதிருக்கோவில் கமிட்டியார்";
    $signEn = "With warm regards,\nThe Temple Committee";

    $t = [];

    /* ── Account ─────────────────────────────────────────────────────────── */

    $t['welcome'] = [
        'category'    => 'general',
        'description' => 'Sent when a devotee creates an account on the website.',
        'variables'   => ['devoteeName', 'ctaUrl'],
        'cta_path'    => '/account',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'கோயில் குடும்பத்திற்கு வரவேற்கிறோம்',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}} இணையதளத்தில் கணக்கு தொடங்கியதற்கு நன்றி. இனி சேவை பதிவு செய்யலாம், உங்கள் பதிவுகளையும் நன்கொடைகளையும் ஒரே இடத்தில் பார்க்கலாம், திருவிழா மற்றும் பூஜை அறிவிப்புகளையும் பெறலாம்.\n\nஎங்கள் மின்னஞ்சல் வந்ததும் உங்கள் மின்னஞ்சல் முகவரியை உறுதிப்படுத்துங்கள்; அப்போதுதான் பதிவு உறுதிப்படுத்தல்களும் ரசீதுகளும் உங்களை வந்து சேரும்.\n\n$signTa",
                    'cta_label' => 'என் கணக்கு',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: வணக்கம் {{devoteeName}}, உங்கள் கணக்கு தயார். இனி இணையதளத்தில் சேவை பதிவு செய்யலாம்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}} 🙏\n\n*{{templeName}}* இணையதளத்தில் உங்கள் கணக்கு தயார். சேவை பதிவு செய்யவும், உங்கள் பதிவுகளையும் நன்கொடைகளையும் பார்க்கவும்:\n{{ctaUrl}}",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Welcome to the temple family',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you for creating an account with {{templeName}}. You can now book a seva, see your bookings and offerings in one place, and hear from the temple about festivals and poojas.\n\nPlease confirm your email address when our message arrives, so that booking confirmations and receipts can reach you.\n\n$signEn",
                    'cta_label' => 'Open my account',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: Vanakkam {{devoteeName}}, your account is ready. You can now book sevas on our website.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}} 🙏\n\nYour account with *{{templeName}}* is ready. Book a seva and see your bookings and offerings here:\n{{ctaUrl}}",
                ],
            ],
        ],
    ];

    $t['email_verification'] = [
        'category'    => 'security',
        'description' => 'The link a devotee opens to confirm their email address. Sent at sign-up and whenever they ask for it again. The link goes only by email.',
        'variables'   => ['devoteeName', 'verifyUrl', 'expiresHours', 'ctaUrl'],
        'cta_path'    => '{{verifyUrl}}',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் மின்னஞ்சலை உறுதிப்படுத்துங்கள்',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}} இணையதளத்தில் கணக்கு தொடங்கியதற்கு நன்றி. பதிவு உறுதிப்படுத்தல்களும் ரசீதுகளும் உங்களை வந்து சேர, இந்த மின்னஞ்சல் முகவரியை உறுதிப்படுத்துங்கள். அதற்கு இந்த இணைப்பைத் திறக்கவும்:\n\n{{verifyUrl}}\n\nஇந்த இணைப்பு {{expiresHours}} மணி நேரம் செல்லுபடியாகும். நீங்கள் கணக்கு தொடங்கவில்லை என்றால், இந்தச் செய்தியைப் புறக்கணிக்கலாம்; எதுவும் மாறாது.",
                    'cta_label' => 'மின்னஞ்சலை உறுதிப்படுத்து',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: மின்னஞ்சலை உறுதிப்படுத்தும் இணைப்பை உங்கள் மின்னஞ்சலுக்கு அனுப்பியுள்ளோம். ஸ்பேம் கோப்புறையையும் பாருங்கள்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் மின்னஞ்சல் முகவரியை உறுதிப்படுத்தும் இணைப்பை *மின்னஞ்சலில்* அனுப்பியுள்ளோம். அது {{expiresHours}} மணி நேரம் செல்லுபடியாகும். ஸ்பேம் கோப்புறையையும் பாருங்கள்.\n\nநீங்கள் கணக்கு தொடங்கவில்லை என்றால், இதைப் புறக்கணிக்கலாம்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Confirm your email address',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you for creating an account with {{templeName}}. Please confirm this email address so we can send you booking confirmations and receipts. Open this link to confirm:\n\n{{verifyUrl}}\n\nThis link works for {{expiresHours}} hours. If you did not create an account, ignore this message and nothing will happen.",
                    'cta_label' => 'Confirm my email',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: we have emailed you a link to confirm your email address. Please check your inbox and spam folder.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nWe have sent a link to confirm your email address *by email*. It works for {{expiresHours}} hours; please check your spam folder too.\n\nIf you did not create an account, you can ignore this.",
                ],
            ],
        ],
    ];

    $t['email_verified'] = [
        'category'    => 'security',
        'description' => 'Sent once a devotee has confirmed their email address.',
        'variables'   => ['devoteeName', 'ctaUrl'],
        'cta_path'    => '/account',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் மின்னஞ்சல் உறுதிப்படுத்தப்பட்டது',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் மின்னஞ்சல் முகவரி உறுதிப்படுத்தப்பட்டது. இனி சில நொடிகளில் சேவை பதிவு செய்யலாம்; நீங்கள் பதிவு செய்தவை, வழங்கிய நன்கொடைகள் அனைத்தையும் ஒரே இடத்தில் பார்க்கலாம்.",
                    'cta_label' => 'என் கணக்கு',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் மின்னஞ்சல் முகவரி உறுதிப்படுத்தப்பட்டது. நன்றி.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் மின்னஞ்சல் முகவரி *உறுதிப்படுத்தப்பட்டது*. இனி சேவை பதிவுகளும் நன்கொடைகளும் உங்கள் கணக்கில் ஒரே இடத்தில்:\n{{ctaUrl}}",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Your email is confirmed',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour email address is confirmed. You can now book a seva in a couple of taps, and see everything you have booked or given in one place.",
                    'cta_label' => 'Open my account',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your email address is confirmed. You can now see your bookings and offerings in your account.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour email address is *confirmed*. Your bookings and offerings are all in one place in your account:\n{{ctaUrl}}",
                ],
            ],
        ],
    ];

    $t['password_reset'] = [
        'category'    => 'security',
        'description' => 'The link to choose a new password, sent when someone asks to reset it. The link goes only by email.',
        'variables'   => ['devoteeName', 'resetUrl', 'expiresMinutes', 'ctaUrl'],
        'cta_path'    => '{{resetUrl}}',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'புதிய கடவுச்சொல் அமையுங்கள்',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}} இணையதளத்தில் உள்ள உங்கள் கணக்கின் கடவுச்சொல்லை மாற்றக் கோரிக்கை வந்துள்ளது. அது நீங்கள்தான் என்றால், புதிய கடவுச்சொல் அமைக்க இந்த இணைப்பைத் திறக்கவும்:\n\n{{resetUrl}}\n\nஇந்த இணைப்பு {{expiresMinutes}} நிமிடங்கள் மட்டுமே செல்லுபடியாகும்; ஒருமுறை மட்டுமே பயன்படுத்த முடியும்.\n\nஇது நீங்கள் இல்லை என்றால், உங்கள் கடவுச்சொல் மாறவில்லை; இந்தச் செய்தியைப் புறக்கணிக்கலாம். இதுபோன்ற செய்திகள் தொடர்ந்து வந்தால், கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'புதிய கடவுச்சொல் அமை',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: கடவுச்சொல் மாற்றும் இணைப்பை மின்னஞ்சலில் அனுப்பியுள்ளோம். நீங்கள் கேட்கவில்லை எனில் புறக்கணிக்கவும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கணக்கின் கடவுச்சொல்லை மாற்றக் கோரிக்கை வந்தது. இணைப்பை *மின்னஞ்சலில்* அனுப்பியுள்ளோம்.\n\nநீங்கள் கேட்கவில்லை என்றால், உங்கள் கடவுச்சொல் மாறவில்லை. சந்தேகம் இருந்தால் {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Set a new password',
                    'body'      => "Vanakkam {{devoteeName}},\n\nSomeone asked to reset the password for your account on the {{templeName}} website. If that was you, open this link to choose a new password:\n\n{{resetUrl}}\n\nThis link works for {{expiresMinutes}} minutes and can be used once.\n\nIf it was not you, your password has not changed and you can ignore this message. If you keep receiving these, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'Set a new password',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: a password reset was requested. We emailed you the link. Not you? Your password is unchanged; ignore this.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nSomeone asked to reset your account password. We have sent the link *by email*.\n\nIf it was not you, your password has not changed. If you are worried, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['password_changed'] = [
        'category'    => 'security',
        'description' => 'Sent after the account password is changed, so the devotee can act if it was not them.',
        'variables'   => ['devoteeName', 'changedAt', 'ctaUrl'],
        'cta_path'    => '/forgot-password',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் கடவுச்சொல் மாற்றப்பட்டது',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}} இணையதளத்தில் உள்ள உங்கள் கணக்கின் கடவுச்சொல் {{changedAt}} அன்று மாற்றப்பட்டது.\n\nஇதை நீங்களே மாற்றியிருந்தால், வேறு எதுவும் செய்ய வேண்டியதில்லை.\n\nநீங்கள் மாற்றவில்லை என்றால், உடனே புதிய கடவுச்சொல் அமையுங்கள்; உங்கள் கணக்கைப் பாதுகாக்க கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'கடவுச்சொல்லை மீட்டமை',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: கடவுச்சொல் மாற்றப்பட்டது ({{changedAt}}). நீங்கள் இல்லையெனில் அழைக்க: {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கணக்கின் கடவுச்சொல் *{{changedAt}}* அன்று மாற்றப்பட்டது.\n\nநீங்கள் மாற்றவில்லை என்றால், உடனே புதிய கடவுச்சொல் அமையுங்கள்:\n{{ctaUrl}}\nமேலும் {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Your password was changed',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThe password for your account on the {{templeName}} website was changed on {{changedAt}}.\n\nIf you made this change, there is nothing more to do.\n\nIf you did not, reset your password straight away and call the temple office on {{supportPhone}} so we can help secure your account.",
                    'cta_label' => 'Reset my password',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your account password was changed on {{changedAt}}. Not you? Reset it now and call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour account password was changed on *{{changedAt}}*.\n\nIf this was not you, reset it straight away:\n{{ctaUrl}}\nand call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['profile_updated'] = [
        'category'    => 'security',
        'description' => 'Sent when important account details (name, phone, address) are changed. changedFields is a short readable list.',
        'variables'   => ['devoteeName', 'changedFields', 'ctaUrl'],
        'cta_path'    => '/account?tab=profile',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் கணக்கு விவரங்கள் மாற்றப்பட்டன',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கோயில் கணக்கில் இந்த விவரங்கள் இப்போது மாற்றப்பட்டன: {{changedFields}}.\n\nஇதை நீங்களே மாற்றியிருந்தால், வேறு எதுவும் செய்ய வேண்டியதில்லை. நீங்கள் மாற்றவில்லை என்றால், உடனே கடவுச்சொல்லை மாற்றி, கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'என் விவரங்கள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் கணக்கில் {{changedFields}} மாற்றப்பட்டது. நீங்கள் இல்லையெனில் {{supportPhone}} அழைக்கவும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கோயில் கணக்கில் மாற்றப்பட்டவை: *{{changedFields}}*.\n\nஇதை நீங்கள் செய்யவில்லை என்றால், உடனே கடவுச்சொல்லை மாற்றி {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Your account details were updated',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThese details on your temple account were just changed: {{changedFields}}.\n\nIf you made this change, there is nothing more to do. If you did not, change your password now and call the temple office on {{supportPhone}}.",
                    'cta_label' => 'Review my details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your account details were changed ({{changedFields}}). Not you? Change your password and call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nThese details on your temple account were changed: *{{changedFields}}*.\n\nIf this was not you, change your password now and call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['phone_otp'] = [
        'category'    => 'security',
        'description' => 'The one-time code that verifies a mobile number. The code comes first so phones can show it in the notification.',
        'variables'   => ['devoteeName', 'otpCode', 'expiresMinutes', 'ctaUrl'],
        'cta_path'    => '/account?tab=profile',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் சரிபார்ப்புக் குறியீடு',
                    'body'      => "{{otpCode}} என்பது உங்கள் {{templeShortName}} சரிபார்ப்புக் குறியீடு. இது {{expiresMinutes}} நிமிடங்களில் காலாவதியாகும்.\n\nஇந்தக் குறியீட்டை யாரிடமும் பகிர வேண்டாம். கோயிலிலிருந்து யாரும் இதை உங்களிடம் கேட்க மாட்டார்கள்.",
                    'cta_label' => 'என் விவரங்கள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{otpCode}} உங்கள் சரிபார்ப்புக் குறியீடு. {{expiresMinutes}} நிமிடத்தில் காலாவதியாகும். யாரிடமும் பகிர வேண்டாம்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{otpCode}}* உங்கள் {{templeShortName}} சரிபார்ப்புக் குறியீடு. இது {{expiresMinutes}} நிமிடங்களில் காலாவதியாகும்.\n\nஇந்தக் குறியீட்டை யாரிடமும் பகிர வேண்டாம்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Your verification code',
                    'body'      => "{{otpCode}} is your {{templeShortName}} verification code. It expires in {{expiresMinutes}} minutes.\n\nNever share this code with anyone. No one from the temple will ever ask you for it.",
                    'cta_label' => 'My details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{otpCode}} is your {{templeShortName}} verification code. It expires in {{expiresMinutes}} minutes. Never share this code with anyone.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{otpCode}}* is your {{templeShortName}} verification code. It expires in {{expiresMinutes}} minutes.\n\nNever share this code with anyone.",
                ],
            ],
        ],
    ];

    $t['phone_verified'] = [
        'category'    => 'security',
        'description' => 'Sent when a devotee verifies their mobile number. phoneMasked shows only the last digits, e.g. +91 ******2296.',
        'variables'   => ['devoteeName', 'phoneMasked', 'ctaUrl'],
        'cta_path'    => '/account?tab=notifications',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் தொலைபேசி எண் சரிபார்க்கப்பட்டது',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் தொலைபேசி எண் {{phoneMasked}} இப்போது சரிபார்க்கப்பட்டது. நீங்கள் இயக்கியுள்ள வழிகளில், சேவை பதிவுத் தகவல்களையும் முக்கிய அறிவிப்புகளையும் கோயில் இந்த எண்ணுக்கு அனுப்பும்.\n\nஇதை நீங்கள் செய்யவில்லை என்றால், கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'அறிவிப்பு அமைப்புகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் தொலைபேசி எண் {{phoneMasked}} சரிபார்க்கப்பட்டது.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் தொலைபேசி எண் *{{phoneMasked}}* சரிபார்க்கப்பட்டது.\n\nஇதை நீங்கள் செய்யவில்லை என்றால், {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Your mobile number is verified',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour mobile number {{phoneMasked}} is now verified. The temple can reach you there with booking updates and important notices, on the channels you have turned on.\n\nIf you did not do this, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'Notification settings',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your mobile number {{phoneMasked}} is now verified. Not you? Call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour mobile number *{{phoneMasked}}* is now verified.\n\nIf you did not do this, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    /* ── Seva bookings ───────────────────────────────────────────────────── */

    $bookingVars = ['devoteeName', 'bookingNumber', 'sevaName', 'bookingDate', 'ctaUrl'];

    $t['booking_received'] = [
        'category'    => 'booking',
        'description' => 'Sent when a seva booking request is received, before the office confirms it. bookingDate is the preferred date, or "date to be confirmed".',
        'variables'   => $bookingVars,
        'cta_path'    => '/account?tab=bookings',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை கோரிக்கை பெறப்பட்டது: {{sevaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{bookingDate}} அன்று {{sevaName}} சேவைக்கான உங்கள் கோரிக்கை பெறப்பட்டது. உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nகோயில் அலுவலகம் விரைவில் உங்களைத் தொடர்பு கொண்டு, பெரும்பாலும் தொலைபேசியில், உறுதி செய்யும். உறுதியானதும் மீண்டும் தெரிவிக்கிறோம்.\n\nசந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'என் சேவை பதிவுகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{sevaName}} ({{bookingDate}}) கோரிக்கை பெறப்பட்டது. பதிவு எண் {{bookingNumber}}. அலுவலகம் விரைவில் உறுதி செய்யும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் சேவை கோரிக்கை பெறப்பட்டது.\n\n*சேவை:* {{sevaName}}\n*தேதி:* {{bookingDate}}\n*பதிவு எண்:* {{bookingNumber}}\n\nகோயில் அலுவலகம் விரைவில் உங்களைத் தொடர்பு கொண்டு உறுதி செய்யும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Seva request received: {{sevaName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nWe have received your request for {{sevaName}} on {{bookingDate}}. Your booking number is {{bookingNumber}}.\n\nThe temple office will confirm it with you shortly, usually by phone. We will let you know again once it is confirmed.\n\nQuestions? Call the temple office on {{supportPhone}}.",
                    'cta_label' => 'View my bookings',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: we received your {{sevaName}} request for {{bookingDate}} (booking {{bookingNumber}}). The office will confirm it soon.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nWe have received your seva request.\n\n*Seva:* {{sevaName}}\n*Date:* {{bookingDate}}\n*Booking no.:* {{bookingNumber}}\n\nThe temple office will contact you shortly to confirm it.",
                ],
            ],
        ],
    ];

    $t['booking_confirmed'] = [
        'category'    => 'booking',
        'description' => 'Sent when the committee confirms a seva booking.',
        'variables'   => $bookingVars,
        'cta_path'    => '/account?tab=bookings',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை உறுதியானது: {{sevaName}}, {{bookingDate}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{bookingDate}} அன்று உங்கள் {{sevaName}} சேவை உறுதி செய்யப்பட்டது. உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nசற்று முன்னதாக வந்து, கோயில் அலுவலகத்தில் உங்கள் பதிவு எண்ணைத் தெரிவிக்கவும். கோயிலில் உங்களைச் சந்திக்கக் காத்திருக்கிறோம்.\n\nமாற்றவோ ரத்து செய்யவோ, கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'பதிவைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{bookingDate}} அன்று உங்கள் {{sevaName}} சேவை உறுதியானது. பதிவு எண் {{bookingNumber}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் சேவை *உறுதி செய்யப்பட்டது* 🙏\n\n*சேவை:* {{sevaName}}\n*தேதி:* {{bookingDate}}\n*பதிவு எண்:* {{bookingNumber}}\n\nகோயில் அலுவலகத்தில் உங்கள் பதிவு எண்ணைத் தெரிவிக்கவும். மாற்றவோ ரத்து செய்யவோ {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Seva confirmed: {{sevaName}} on {{bookingDate}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour {{sevaName}} on {{bookingDate}} is confirmed. Your booking number is {{bookingNumber}}.\n\nPlease arrive a little early and give your booking number at the temple office. We look forward to seeing you at the temple.\n\nTo change or cancel, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'View booking',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your {{sevaName}} on {{bookingDate}} is confirmed. Booking {{bookingNumber}}. To change it, call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour seva is *confirmed* 🙏\n\n*Seva:* {{sevaName}}\n*Date:* {{bookingDate}}\n*Booking no.:* {{bookingNumber}}\n\nPlease give your booking number at the temple office. To change or cancel, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['booking_modified'] = [
        'category'    => 'booking',
        'description' => 'Sent when the office changes a booking (usually its date). changes is one readable sentence.',
        'variables'   => ['devoteeName', 'bookingNumber', 'sevaName', 'bookingDate', 'changes', 'ctaUrl'],
        'cta_path'    => '/account?tab=bookings',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை பதிவு மாற்றப்பட்டது: {{sevaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{sevaName}} சேவைக்கான உங்கள் பதிவு ({{bookingNumber}}) மாற்றப்பட்டுள்ளது.\n\nமாற்றம்: {{changes}}\nதேதி: {{bookingDate}}\n\nஇதில் ஏதேனும் தவறு இருந்தால், கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'பதிவைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: பதிவு {{bookingNumber}} மாற்றப்பட்டது. புதிய தேதி {{bookingDate}}. விவரங்களுக்கு {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் சேவை பதிவு *மாற்றப்பட்டுள்ளது*.\n\n*சேவை:* {{sevaName}}\n*பதிவு எண்:* {{bookingNumber}}\n*மாற்றம்:* {{changes}}\n*தேதி:* {{bookingDate}}\n\nஏதேனும் தவறு இருந்தால் {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Booking updated: {{sevaName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour booking {{bookingNumber}} for {{sevaName}} has been updated.\n\nWhat changed: {{changes}}\nDate: {{bookingDate}}\n\nIf this does not look right, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'View booking',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: booking {{bookingNumber}} ({{sevaName}}) was updated. {{changes}}. Questions? Call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour seva booking has been *updated*.\n\n*Seva:* {{sevaName}}\n*Booking no.:* {{bookingNumber}}\n*What changed:* {{changes}}\n*Date:* {{bookingDate}}\n\nIf this does not look right, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['booking_cancelled'] = [
        'category'    => 'booking',
        'description' => 'Sent when a seva booking is cancelled. reason is shown to the devotee; keep it kind and short.',
        'variables'   => ['devoteeName', 'bookingNumber', 'sevaName', 'bookingDate', 'reason', 'ctaUrl'],
        'cta_path'    => '/sevas',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை பதிவு ரத்து: {{sevaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{bookingDate}} அன்று {{sevaName}} சேவைக்கான உங்கள் பதிவு ({{bookingNumber}}) ரத்து செய்யப்பட்டது.\n\nகாரணம்: {{reason}}\n\nஏற்பட்ட சிரமத்திற்கு வருந்துகிறோம். வேறு தேதியில் பதிவு செய்ய சேவைகள் பக்கத்தைப் பாருங்கள் அல்லது கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'வேறு தேதியில் பதிவு செய்ய',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{bookingDate}} {{sevaName}} பதிவு ({{bookingNumber}}) ரத்து செய்யப்பட்டது. விவரங்களுக்கு {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் சேவை பதிவு *ரத்து செய்யப்பட்டது*.\n\n*சேவை:* {{sevaName}}\n*தேதி:* {{bookingDate}}\n*பதிவு எண்:* {{bookingNumber}}\n*காரணம்:* {{reason}}\n\nஏற்பட்ட சிரமத்திற்கு வருந்துகிறோம். வேறு தேதியில் பதிவு செய்ய {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Booking cancelled: {{sevaName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour booking {{bookingNumber}} for {{sevaName}} on {{bookingDate}} has been cancelled.\n\nReason: {{reason}}\n\nWe are sorry for the inconvenience. To book another date, visit the Sevas page or call the temple office on {{supportPhone}}.",
                    'cta_label' => 'Book another date',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your {{sevaName}} booking {{bookingNumber}} for {{bookingDate}} is cancelled. We are sorry. To rebook, call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour seva booking has been *cancelled*.\n\n*Seva:* {{sevaName}}\n*Date:* {{bookingDate}}\n*Booking no.:* {{bookingNumber}}\n*Reason:* {{reason}}\n\nWe are sorry for the inconvenience. To book another date, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['booking_completed'] = [
        'category'    => 'booking',
        'description' => 'Sent after the seva has been performed, as a thank-you.',
        'variables'   => ['devoteeName', 'bookingNumber', 'sevaName', 'ctaUrl'],
        'cta_path'    => '/sevas',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் {{sevaName}} சேவை நிறைவடைந்தது',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் {{sevaName}} சேவை (பதிவு எண் {{bookingNumber}}) சிறப்பாக நடைபெற்றது. உங்கள் பக்திக்கு நன்றி. அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் என்றும் துணை நிற்கட்டும்.\n\nஅடுத்த சேவையை எப்போது வேண்டுமானாலும் பதிவு செய்யலாம்.",
                    'cta_label' => 'மற்றொரு சேவை பதிவு செய்ய',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் {{sevaName}} சேவை சிறப்பாக நடைபெற்றது. உங்கள் பக்திக்கு நன்றி.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் *{{sevaName}}* சேவை (பதிவு எண் {{bookingNumber}}) சிறப்பாக நடைபெற்றது. உங்கள் பக்திக்கு நன்றி 🙏\n\nகுலதெய்வங்களின் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for your {{sevaName}} seva',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour {{sevaName}} seva (booking {{bookingNumber}}) has been performed. Thank you for your devotion. May the blessings of Arulmigu Sri Lingammal, Sri Renukadevi and Sri Chinnammal be with you and your family always.\n\nYou can book your next seva whenever you wish.",
                    'cta_label' => 'Book another seva',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your {{sevaName}} seva (booking {{bookingNumber}}) has been performed. Thank you for your devotion.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour *{{sevaName}}* seva (booking {{bookingNumber}}) has been performed. Thank you for your devotion 🙏\n\nMay the blessings of our kula deivams be with you and your family.",
                ],
            ],
        ],
    ];

    $t['booking_reminder'] = [
        'category'    => 'booking',
        'description' => 'Sent the evening before a confirmed seva, with the address and directions.',
        'variables'   => ['devoteeName', 'bookingNumber', 'sevaName', 'bookingDate', 'templeAddress', 'mapsUrl', 'ctaUrl'],
        'cta_path'    => '/account?tab=bookings',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நினைவூட்டல்: நாளை {{sevaName}} சேவை',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் {{sevaName}} சேவை நாளை, {{bookingDate}} அன்று நடைபெறும். உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nகோயில் முகவரி: {{templeAddress}}\nவழி: {{mapsUrl}}\n\nசற்று முன்னதாக வாருங்கள். வர இயலவில்லை என்றால், கோயில் அலுவலகத்திற்கு {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.",
                    'cta_label' => 'பதிவைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: நினைவூட்டல் - நாளை ({{bookingDate}}) உங்கள் {{sevaName}} சேவை. பதிவு எண் {{bookingNumber}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*நினைவூட்டல்:* உங்கள் சேவை நாளை நடைபெறும்.\n\n*சேவை:* {{sevaName}}\n*தேதி:* {{bookingDate}}\n*பதிவு எண்:* {{bookingNumber}}\n*முகவரி:* {{templeAddress}}\n*வழி:* {{mapsUrl}}\n\nவர இயலவில்லை என்றால் {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Reminder: {{sevaName}} tomorrow',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThis is a reminder that your {{sevaName}} seva is tomorrow, {{bookingDate}}. Your booking number is {{bookingNumber}}.\n\nTemple address: {{templeAddress}}\nDirections: {{mapsUrl}}\n\nPlease arrive a little early. If you cannot come, let the temple office know on {{supportPhone}}.",
                    'cta_label' => 'View booking',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => "{{templeShortName}}: reminder, your {{sevaName}} seva is tomorrow, {{bookingDate}} (booking {{bookingNumber}}). Can't come? Call {{supportPhone}}.",
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Reminder:* your seva is tomorrow.\n\n*Seva:* {{sevaName}}\n*Date:* {{bookingDate}}\n*Booking no.:* {{bookingNumber}}\n*Address:* {{templeAddress}}\n*Directions:* {{mapsUrl}}\n\nIf you cannot come, please call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    /* ── Donations and payments ──────────────────────────────────────────── */

    $t['donation_received'] = [
        'category'    => 'donation',
        'description' => 'Sent when a donation pledge is recorded. donationAmount is formatted, e.g. "Rs. 1,001" (₹ would make an SMS twice as long).',
        'variables'   => ['devoteeName', 'receiptNumber', 'donationAmount', 'donationPurpose', 'ctaUrl'],
        'cta_path'    => '/account?tab=donations',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் நன்கொடைக்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nநன்றி. {{donationPurpose}} நோக்கத்திற்கான உங்கள் {{donationAmount}} நன்கொடை பதிவு செய்யப்பட்டது (குறிப்பு எண் {{receiptNumber}}).\n\nநன்கொடை வந்து சேர்ந்ததும் கோயில் கமிட்டியார் ரசீது அனுப்புவார்கள். உங்கள் முகவரி தெளிவாக இருந்தால் மட்டுமே ரசீது அனுப்ப முடியும்; உங்கள் கணக்கில் முழு முகவரியைச் சேமித்து வையுங்கள்.\n\nகுலதெய்வங்களின் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.",
                    'cta_label' => 'என் நன்கொடைகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: நன்றி. உங்கள் {{donationAmount}} நன்கொடை பதிவு செய்யப்பட்டது. குறிப்பு எண் {{receiptNumber}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் நன்கொடைக்கு நன்றி 🙏\n\n*தொகை:* {{donationAmount}}\n*நோக்கம்:* {{donationPurpose}}\n*குறிப்பு எண்:* {{receiptNumber}}\n\nநன்கொடை வந்து சேர்ந்ததும் ரசீது அனுப்பப்படும். உங்கள் கணக்கில் முழு முகவரி இருப்பதை உறுதி செய்யுங்கள்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for your offering',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you. Your offering of {{donationAmount}} towards {{donationPurpose}} has been recorded (reference {{receiptNumber}}).\n\nThe temple committee will send your receipt once the offering is received. A receipt can only be sent when your full address is clear, so please keep your postal address saved in your account.\n\nMay the blessings of our kula deivams be with you and your family.",
                    'cta_label' => 'View my offerings',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: thank you. Your offering of {{donationAmount}} for {{donationPurpose}} is recorded (ref {{receiptNumber}}). Receipt to follow.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nThank you for your offering 🙏\n\n*Amount:* {{donationAmount}}\n*Purpose:* {{donationPurpose}}\n*Reference:* {{receiptNumber}}\n\nYour receipt will follow once the offering is received. Please make sure your full postal address is saved in your account.",
                ],
            ],
        ],
    ];

    $t['donation_receipt'] = [
        'category'    => 'donation',
        'description' => 'The receipt for a donation, sent by the committee from Admin → Donations. trustName and taxNote are filled in from the Trust registration automatically.',
        'variables'   => ['devoteeName', 'receiptNumber', 'donationAmount', 'donationPurpose', 'donationDate', 'trustName', 'taxNote', 'ctaUrl'],
        'cta_path'    => '/account?tab=donations',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நன்கொடை ரசீது {{receiptNumber}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{trustName}}-க்கு நீங்கள் வழங்கிய நன்கொடைக்கான ரசீதை நன்றியுடன் அனுப்புகிறோம்.\n\nரசீது எண்: {{receiptNumber}}\nதொகை: {{donationAmount}}\nநோக்கம்: {{donationPurpose}}\nதேதி: {{donationDate}}\n\n{{taxNote}}\n\nஉங்கள் பதிவுகளுக்காக இந்தச் செய்தியைப் பாதுகாத்து வையுங்கள். அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.\n\n$signTa",
                    'cta_label' => 'என் நன்கொடைகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: ரசீது {{receiptNumber}} - {{donationAmount}} ({{donationDate}}). உங்கள் நன்கொடைக்கு நன்றி.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*நன்கொடை ரசீது*\n\n*ரசீது எண்:* {{receiptNumber}}\n*தொகை:* {{donationAmount}}\n*நோக்கம்:* {{donationPurpose}}\n*தேதி:* {{donationDate}}\n\n{{trustName}}\n{{taxNote}}\n\nஉங்கள் நன்கொடைக்கு நன்றி 🙏",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Donation receipt {{receiptNumber}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nWith gratitude, here is the receipt for your offering to the {{trustName}}.\n\nReceipt number: {{receiptNumber}}\nAmount: {{donationAmount}}\nPurpose: {{donationPurpose}}\nDate: {{donationDate}}\n\n{{taxNote}}\n\nPlease keep this message for your records. May the blessings of Arulmigu Sri Lingammal, Sri Renukadevi and Sri Chinnammal be with you and your family.\n\n$signEn",
                    'cta_label' => 'View my offerings',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: receipt {{receiptNumber}} for your offering of {{donationAmount}} ({{donationPurpose}}, {{donationDate}}). Thank you for your support.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Donation receipt*\n\n*Receipt no.:* {{receiptNumber}}\n*Amount:* {{donationAmount}}\n*Purpose:* {{donationPurpose}}\n*Date:* {{donationDate}}\n\n{{trustName}}\n{{taxNote}}\n\nThank you for your support 🙏",
                ],
            ],
        ],
    ];

    $t['payment_success'] = [
        'category'    => 'payment',
        'description' => 'Sent when an online payment succeeds. No payment gateway exists yet; this is ready for when one is added.',
        'variables'   => ['devoteeName', 'paymentReference', 'paymentAmount', 'paymentFor', 'ctaUrl'],
        'cta_path'    => '/account',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'கட்டணம் பெறப்பட்டது: {{paymentAmount}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{paymentFor}}-க்கான உங்கள் {{paymentAmount}} கட்டணம் பெறப்பட்டது. நன்றி.\n\nகட்டணக் குறிப்பு எண்: {{paymentReference}}\n\nஇந்தக் கட்டணம் பற்றி கோயில் அலுவலகத்தைத் தொடர்பு கொள்ளும்போது இந்தக் குறிப்பு எண்ணைத் தெரிவிக்கவும்.",
                    'cta_label' => 'என் கணக்கு',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{paymentFor}}-க்கான {{paymentAmount}} கட்டணம் பெறப்பட்டது. குறிப்பு எண் {{paymentReference}}. நன்றி.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கட்டணம் *பெறப்பட்டது*. நன்றி.\n\n*தொகை:* {{paymentAmount}}\n*எதற்கு:* {{paymentFor}}\n*குறிப்பு எண்:* {{paymentReference}}",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Payment received: {{paymentAmount}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nWe have received your payment of {{paymentAmount}} for {{paymentFor}}. Thank you.\n\nPayment reference: {{paymentReference}}\n\nPlease quote this reference if you contact the temple office about this payment.",
                    'cta_label' => 'Open my account',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: payment of {{paymentAmount}} for {{paymentFor}} received. Ref {{paymentReference}}. Thank you.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour payment has been *received*. Thank you.\n\n*Amount:* {{paymentAmount}}\n*For:* {{paymentFor}}\n*Reference:* {{paymentReference}}",
                ],
            ],
        ],
    ];

    $t['payment_failed'] = [
        'category'    => 'payment',
        'description' => 'Sent when an online payment fails. No payment gateway exists yet; this is ready for when one is added.',
        'variables'   => ['devoteeName', 'paymentReference', 'paymentAmount', 'paymentFor', 'reason', 'ctaUrl'],
        'cta_path'    => '/account',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'கட்டணம் நிறைவடையவில்லை: {{paymentAmount}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{paymentFor}}-க்கான உங்கள் {{paymentAmount}} கட்டணம் நிறைவடையவில்லை.\n\nகாரணம்: {{reason}}\nகட்டணக் குறிப்பு எண்: {{paymentReference}}\n\nஉங்கள் கணக்கிலிருந்து பணம் எடுக்கப்பட்டிருந்தால், பொதுவாக உங்கள் வங்கி அதைத் தானாகத் திருப்பி அளிக்கும். ஒரு வாரத்திற்குள் திரும்ப வரவில்லை என்றால், மேலே உள்ள குறிப்பு எண்ணுடன் கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'என் கணக்கு',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{paymentAmount}} கட்டணம் நிறைவடையவில்லை. குறிப்பு எண் {{paymentReference}}. உதவிக்கு {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கட்டணம் *நிறைவடையவில்லை*.\n\n*தொகை:* {{paymentAmount}}\n*எதற்கு:* {{paymentFor}}\n*காரணம்:* {{reason}}\n*குறிப்பு எண்:* {{paymentReference}}\n\nபணம் எடுக்கப்பட்டு ஒரு வாரத்தில் திரும்ப வரவில்லை என்றால் {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Payment not completed: {{paymentAmount}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour payment of {{paymentAmount}} for {{paymentFor}} did not go through.\n\nReason: {{reason}}\nPayment reference: {{paymentReference}}\n\nIf the amount was taken from your account, your bank normally returns it automatically. If it has not come back within a week, call the temple office on {{supportPhone}} with the reference above.",
                    'cta_label' => 'Open my account',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your payment of {{paymentAmount}} for {{paymentFor}} did not go through (ref {{paymentReference}}). Help: {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour payment *did not go through*.\n\n*Amount:* {{paymentAmount}}\n*For:* {{paymentFor}}\n*Reason:* {{reason}}\n*Reference:* {{paymentReference}}\n\nIf money was taken and has not come back within a week, call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    /* ── Events, festivals, poojas ───────────────────────────────────────── */

    $t['event_registered'] = [
        'category'    => 'event',
        'description' => 'Sent when a devotee registers for a temple event. No event registration exists yet; this is ready for when it is added.',
        'variables'   => ['devoteeName', 'eventName', 'eventDate', 'eventLocation', 'ctaUrl'],
        'cta_path'    => '/events',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'பதிவு செய்யப்பட்டது: {{eventName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{eventName}} நிகழ்வுக்கு நீங்கள் பதிவு செய்யப்பட்டுள்ளீர்கள்.\n\nநாள்: {{eventDate}}\nஇடம்: {{eventLocation}}\n\nஉங்களைச் சந்திக்கக் காத்திருக்கிறோம். திட்டம் மாறினால், கோயில் அலுவலகத்திற்கு {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.",
                    'cta_label' => 'நிகழ்வுகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{eventName}} ({{eventDate}}) நிகழ்வுக்கு நீங்கள் பதிவு செய்யப்பட்டுள்ளீர்கள்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nநீங்கள் *பதிவு செய்யப்பட்டுள்ளீர்கள்* 🙏\n\n*நிகழ்வு:* {{eventName}}\n*நாள்:* {{eventDate}}\n*இடம்:* {{eventLocation}}",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'You are registered: {{eventName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYou are registered for {{eventName}}.\n\nWhen: {{eventDate}}\nWhere: {{eventLocation}}\n\nWe look forward to seeing you. If your plans change, please let the temple office know on {{supportPhone}}.",
                    'cta_label' => 'View events',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: you are registered for {{eventName}} on {{eventDate}} at {{eventLocation}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYou are *registered* 🙏\n\n*Event:* {{eventName}}\n*When:* {{eventDate}}\n*Where:* {{eventLocation}}",
                ],
            ],
        ],
    ];

    $t['event_cancelled'] = [
        'category'    => 'event',
        'description' => 'Sent to registered devotees when a temple event is cancelled.',
        'variables'   => ['devoteeName', 'eventName', 'eventDate', 'reason', 'ctaUrl'],
        'cta_path'    => '/events',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'ரத்து: {{eventName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{eventDate}} அன்று நடைபெறவிருந்த {{eventName}} நிகழ்வு ரத்து செய்யப்பட்டுள்ளது என்பதை வருத்தத்துடன் தெரிவிக்கிறோம்.\n\nகாரணம்: {{reason}}\n\nபுதிய தேதி முடிவானால் உங்களுக்குத் தெரிவிப்போம். சந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'நிகழ்வுகள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{eventDate}} அன்று நடைபெறவிருந்த {{eventName}} ரத்து செய்யப்பட்டது. வருந்துகிறோம்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nவருத்தத்துடன் தெரிவிக்கிறோம்: *{{eventName}}* ({{eventDate}}) *ரத்து செய்யப்பட்டுள்ளது*.\n\n*காரணம்:* {{reason}}\n\nபுதிய தேதி முடிவானால் தெரிவிப்போம். சந்தேகங்களுக்கு {{supportPhone}}.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Cancelled: {{eventName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nWe are sorry to let you know that {{eventName}}, planned for {{eventDate}}, has been cancelled.\n\nReason: {{reason}}\n\nIf a new date is set, we will let you know. For questions, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'View events',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{eventName}} on {{eventDate}} is cancelled. We are sorry. Questions? Call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nWe are sorry to let you know that *{{eventName}}* ({{eventDate}}) has been *cancelled*.\n\n*Reason:* {{reason}}\n\nIf a new date is set, we will let you know. Questions? Call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['event_reminder'] = [
        'category'    => 'event',
        'description' => 'The automatic reminder the evening before a temple event.',
        'variables'   => ['devoteeName', 'eventName', 'eventDate', 'eventLocation', 'ctaUrl'],
        'cta_path'    => '/events',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நாளை: {{eventName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{eventName}} நாளை நடைபெறும் என்பதை நினைவூட்டுகிறோம்.\n\nநாள்: {{eventDate}}\nஇடம்: {{eventLocation}}\n\nஅனைத்து பக்தர்களும் வருக.",
                    'cta_label' => 'விவரங்களைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: நாளை {{eventName}}, {{eventDate}}. அனைவரும் வருக.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*நாளை:* {{eventName}}\n\n*நாள்:* {{eventDate}}\n*இடம்:* {{eventLocation}}\n\nஅனைத்து பக்தர்களும் வருக 🙏",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Tomorrow: {{eventName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nA reminder that {{eventName}} is tomorrow.\n\nWhen: {{eventDate}}\nWhere: {{eventLocation}}\n\nAll devotees are welcome.",
                    'cta_label' => 'View details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: reminder, {{eventName}} is tomorrow, {{eventDate}}, at {{eventLocation}}. All are welcome.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Tomorrow:* {{eventName}}\n\n*When:* {{eventDate}}\n*Where:* {{eventLocation}}\n\nAll devotees are welcome 🙏",
                ],
            ],
        ],
    ];

    $t['festival_reminder'] = [
        'category'    => 'festival',
        'description' => 'An invitation to a temple festival, sent ahead of the day.',
        'variables'   => ['devoteeName', 'eventName', 'eventDate', 'eventLocation', 'ctaUrl'],
        'cta_path'    => '/events',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'திருவிழா: {{eventName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}}-இல் {{eventName}} சிறப்பாகக் கொண்டாடப்படவுள்ளது.\n\nநாள்: {{eventDate}}\nஇடம்: {{eventLocation}}\n\nதங்கள் குடும்பத்தினருடன் வந்து தரிசனம் செய்து, குலதெய்வங்களின் அருளாசி பெறுமாறு அன்புடன் அழைக்கிறோம்.\n\nஅன்புடன் அழைக்கும்,\nதிருக்கோவில் கமிட்டியார்",
                    'cta_label' => 'திருவிழா விவரங்கள்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{eventName}}, {{eventDate}}. குடும்பத்துடன் வருக.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*{{eventName}}* 🙏\n\n*நாள்:* {{eventDate}}\n*இடம்:* {{eventLocation}}\n\nதங்கள் குடும்பத்தினருடன் வந்து குலதெய்வங்களின் அருளாசி பெறுமாறு அன்புடன் அழைக்கிறோம்.\n\n_அன்புடன் அழைக்கும் திருக்கோவில் கமிட்டியார்_",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Festival: {{eventName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\n{{eventName}} will be celebrated at {{templeName}}.\n\nWhen: {{eventDate}}\nWhere: {{eventLocation}}\n\nWe warmly invite you and your family to join us for darshan and to receive the blessings of our kula deivams.\n\n$signEn",
                    'cta_label' => 'Festival details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{eventName}} on {{eventDate}} at {{eventLocation}}. You and your family are warmly invited.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*{{eventName}}* 🙏\n\n*When:* {{eventDate}}\n*Where:* {{eventLocation}}\n\nWe warmly invite you and your family to join us for darshan and receive the blessings of our kula deivams.\n\n_The Temple Committee_",
                ],
            ],
        ],
    ];

    $t['pooja_reminder'] = [
        'category'    => 'pooja',
        'description' => 'The automatic reminder the evening before a scheduled pooja.',
        'variables'   => ['devoteeName', 'poojaName', 'poojaDate', 'poojaTime', 'ctaUrl'],
        'cta_path'    => '/panchangam',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நாளை பூஜை: {{poojaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{poojaDate}} அன்று {{poojaTime}} மணிக்கு கோயிலில் {{poojaName}} நடைபெறும்.\n\nஅனைத்து பக்தர்களும் கலந்து கொண்டு குலதெய்வங்களின் அருளாசி பெற அன்புடன் அழைக்கிறோம்.",
                    'cta_label' => 'பஞ்சாங்கம்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: நாளை ({{poojaDate}}) {{poojaTime}} {{poojaName}}. அனைவரும் வருக.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*நாளை பூஜை:* {{poojaName}}\n\n*நாள்:* {{poojaDate}}\n*நேரம்:* {{poojaTime}}\n\nஅனைத்து பக்தர்களும் கலந்து கொண்டு அருளாசி பெற அன்புடன் அழைக்கிறோம் 🙏",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Pooja tomorrow: {{poojaName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\n{{poojaName}} will be performed at the temple on {{poojaDate}} at {{poojaTime}}.\n\nAll devotees are warmly invited to take part and receive the blessings of our kula deivams.",
                    'cta_label' => 'Panchangam',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{poojaName}} tomorrow, {{poojaDate}} at {{poojaTime}}. All devotees are welcome.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Pooja tomorrow:* {{poojaName}}\n\n*Date:* {{poojaDate}}\n*Time:* {{poojaTime}}\n\nAll devotees are warmly invited to take part 🙏",
                ],
            ],
        ],
    ];

    $t['special_darshan'] = [
        'category'    => 'special_darshan',
        'description' => 'Announces a special darshan (alankaram, festival darshan) with its date and place.',
        'variables'   => ['devoteeName', 'eventName', 'eventDate', 'eventLocation', 'ctaUrl'],
        'cta_path'    => '/events',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சிறப்பு தரிசனம்: {{eventName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nகோயிலில் {{eventName}} சிறப்பு தரிசனம் நடைபெறவுள்ளது.\n\nநாள்: {{eventDate}}\nஇடம்: {{eventLocation}}\n\nதங்கள் குடும்பத்தினருடன் வந்து தரிசனம் செய்ய அன்புடன் அழைக்கிறோம்.",
                    'cta_label' => 'விவரங்களைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: சிறப்பு தரிசனம் - {{eventName}}, {{eventDate}}. அனைவரும் வருக.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*சிறப்பு தரிசனம்:* {{eventName}} 🙏\n\n*நாள்:* {{eventDate}}\n*இடம்:* {{eventLocation}}\n\nதங்கள் குடும்பத்தினருடன் வந்து தரிசனம் செய்ய அன்புடன் அழைக்கிறோம்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Special darshan: {{eventName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nA special darshan, {{eventName}}, will be held at the temple.\n\nWhen: {{eventDate}}\nWhere: {{eventLocation}}\n\nWe warmly invite you and your family for darshan.",
                    'cta_label' => 'View details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: special darshan, {{eventName}}, on {{eventDate}} at {{eventLocation}}. All are welcome.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Special darshan:* {{eventName}} 🙏\n\n*When:* {{eventDate}}\n*Where:* {{eventLocation}}\n\nWe warmly invite you and your family for darshan.",
                ],
            ],
        ],
    ];

    /* ── Volunteers and membership ───────────────────────────────────────── */

    $t['volunteer_registered'] = [
        'category'    => 'volunteer',
        'description' => 'Thanks a devotee who signed up to volunteer. No volunteer module exists yet; this is ready for when one is added.',
        'variables'   => ['devoteeName', 'opportunityName', 'ctaUrl'],
        'cta_path'    => '/account',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'தன்னார்வ சேவைக்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{opportunityName}} பணியில் தன்னார்வலராகச் சேவை செய்ய முன்வந்ததற்கு மனமார்ந்த நன்றி. உங்கள் நேரமும் உழைப்பும் கோயிலுக்குப் பெரும் துணை.\n\nகமிட்டி உறுப்பினர் ஒருவர் விவரங்களுடன் உங்களைத் தொடர்பு கொள்வார். சந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'என் கணக்கு',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{opportunityName}} பணிக்கு முன்வந்ததற்கு நன்றி. விவரங்களுடன் தொடர்பு கொள்வோம்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*{{opportunityName}}* பணியில் தன்னார்வலராகச் சேவை செய்ய முன்வந்ததற்கு மனமார்ந்த நன்றி 🙏\n\nகமிட்டி உறுப்பினர் ஒருவர் விவரங்களுடன் உங்களைத் தொடர்பு கொள்வார்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for volunteering',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you for offering to volunteer for {{opportunityName}}. Your time and effort mean a great deal to the temple.\n\nA committee member will contact you with the details. For questions, call the temple office on {{supportPhone}}.",
                    'cta_label' => 'Open my account',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: thank you for volunteering for {{opportunityName}}. A committee member will contact you with details.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nThank you for volunteering for *{{opportunityName}}* 🙏\n\nA committee member will contact you with the details.",
                ],
            ],
        ],
    ];

    $t['volunteer_opportunity'] = [
        'category'    => 'volunteer',
        'description' => 'Invites devotees to volunteer for a temple activity.',
        'variables'   => ['devoteeName', 'opportunityName', 'eventDate', 'ctaUrl'],
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'தன்னார்வலர்கள் தேவை: {{opportunityName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{eventDate}} அன்று நடைபெறும் {{opportunityName}} பணிக்குக் கோயிலுக்குத் தன்னார்வலர்கள் தேவை.\n\nசில மணி நேரம் சேவை செய்ய முடிந்தால், கோயில் அலுவலகத்திற்கு {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும். ஒவ்வொரு கரமும் வரவேற்கத்தக்கது.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{opportunityName}} பணிக்குத் தன்னார்வலர்கள் தேவை. அழைக்க: {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\n*தன்னார்வலர்கள் தேவை:* {{opportunityName}}\n*நாள்:* {{eventDate}}\n\nசில மணி நேரம் சேவை செய்ய முடிந்தால் {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும் 🙏",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Volunteers needed: {{opportunityName}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThe temple is looking for volunteers for {{opportunityName}} on {{eventDate}}.\n\nIf you can offer a few hours, please let the temple office know on {{supportPhone}}. Every helping hand is welcome.",
                    'cta_label' => 'Contact the temple',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: volunteers needed for {{opportunityName}} on {{eventDate}}. Can you help? Call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\n*Volunteers needed:* {{opportunityName}}\n*When:* {{eventDate}}\n\nIf you can offer a few hours, please call {{supportPhone}} 🙏",
                ],
            ],
        ],
    ];

    $t['membership_renewal'] = [
        'category'    => 'membership',
        'description' => 'Reminds a member that their membership is due for renewal. No membership module exists yet; this is ready for when one is added.',
        'variables'   => ['devoteeName', 'membershipName', 'renewalDate', 'ctaUrl'],
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உறுப்பினர் புதுப்பிப்பு: {{renewalDate}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}}-இல் உங்கள் {{membershipName}} {{renewalDate}} அன்று புதுப்பிக்கப்பட வேண்டும்.\n\nபுதுப்பிக்க அல்லது ஏதேனும் சந்தேகம் இருந்தால், கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் தொடர்பு கொள்ளவும். உங்கள் தொடர்ந்த ஆதரவுக்கு நன்றி.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் {{membershipName}} {{renewalDate}} அன்று புதுப்பிக்க வேண்டும். அழைக்க {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் *{{membershipName}}* புதுப்பிக்கும் நாள்: *{{renewalDate}}*.\n\nபுதுப்பிக்க {{supportPhone}} என்ற எண்ணில் அழைக்கவும். உங்கள் ஆதரவுக்கு நன்றி 🙏",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Membership renewal due {{renewalDate}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour {{membershipName}} with {{templeName}} is due for renewal on {{renewalDate}}.\n\nTo renew, or if you have any questions, please contact the temple office on {{supportPhone}}. Thank you for your continued support.",
                    'cta_label' => 'Contact the temple',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your {{membershipName}} is due for renewal on {{renewalDate}}. To renew, call {{supportPhone}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour *{{membershipName}}* is due for renewal on *{{renewalDate}}*.\n\nTo renew, please call {{supportPhone}}. Thank you for your continued support 🙏",
                ],
            ],
        ],
    ];

    /* ── Announcements, emergencies, campaigns ───────────────────────────── */

    $t['announcement'] = [
        'category'    => 'announcement',
        'description' => 'A temple announcement composed by the committee: a one-line headline and the message.',
        'variables'   => ['devoteeName', 'headline', 'message', 'ctaUrl'],
        'cta_path'    => '/',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => '{{headline}}',
                    'body'      => "{{message}}\n\n$signTa",
                    'cta_label' => 'மேலும் படிக்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{headline}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{headline}}*\n\n{{message}}\n\n_திருக்கோவில் கமிட்டியார்_",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => '{{headline}}',
                    'body'      => "{{message}}\n\n$signEn",
                    'cta_label' => 'Read more',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{headline}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{headline}}*\n\n{{message}}\n\n_The Temple Committee_",
                ],
            ],
        ],
    ];

    $t['emergency'] = [
        'category'    => 'emergency',
        'description' => 'An emergency notice (closure, safety, weather). Reaches devotees even when optional notifications are off.',
        'variables'   => ['devoteeName', 'headline', 'message', 'ctaUrl'],
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => '{{headline}}',
                    'body'      => "{{message}}\n\nஉதவி தேவைப்பட்டால் கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.\n\nதிருக்கோவில் கமிட்டியார்",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}} அவசரம்: {{headline}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*அவசர அறிவிப்பு: {{headline}}*\n\n{{message}}\n\nஉதவிக்கு {{supportPhone}}\n_திருக்கோவில் கமிட்டியார்_",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => '{{headline}}',
                    'body'      => "{{message}}\n\nIf you need help, call the temple office on {{supportPhone}}.\n\nThe Temple Committee",
                    'cta_label' => 'Contact the temple',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}} URGENT: {{headline}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*URGENT: {{headline}}*\n\n{{message}}\n\nHelp: {{supportPhone}}\n_The Temple Committee_",
                ],
            ],
        ],
    ];

    $t['campaign_generic'] = [
        'category'    => 'general',
        'description' => 'The wrapper for free-text campaigns: the committee writes the title and message; the campaign sets the category.',
        'variables'   => ['devoteeName', 'title', 'message', 'ctaUrl'],
        'cta_path'    => '/',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => '{{title}}',
                    'body'      => '{{message}}',
                    'cta_label' => 'விவரங்களைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{title}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{title}}*\n\n{{message}}",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => '{{title}}',
                    'body'      => '{{message}}',
                    'cta_label' => 'View details',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{title}}. {{message}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "*{{title}}*\n\n{{message}}",
                ],
            ],
        ],
    ];

    return $t;
}
