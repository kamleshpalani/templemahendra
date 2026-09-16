<?php
/**
 * backend/includes/notify/defaults.php — the built-in wording of every
 * notification, and the temple facts the wording leans on.
 *
 * These are the words a devotee receives until the committee edits them in
 * Admin → Message Templates (rows in `notification_templates` win; see
 * templates.php for the resolution order). Every key ships Tamil and English,
 * a shared version ("any": the email, and the copy the admin shows) and two
 * channel overrides:
 *
 *   sms       One segment wherever it can be. English stays within 160 GSM-7
 *             characters with realistic values (tests/notify-templates-unit.php
 *             checks it; tests/notify-unit.php checks the payment templates,
 *             whose donation SMS carries its receipt link), so no curly
 *             quotes, dashes or ₹ — each would switch the whole message to
 *             UCS-2 and halve its room. Tamil is always UCS-2 (70 per
 *             segment), so it says only what cannot wait.
 *   whatsapp  The same message with *bold* labels, which WhatsApp renders.
 *
 * Voice: warm, respectful and plain. Tamil uses the site's own words (சேவை
 * பதிவு, நன்கொடை, கோயில் அலுவலகம், உறுதிப்படுத்து); English is plain Indian
 * English and greets with "Vanakkam", as the site's emails always have.
 * Titles carry no personal names: they appear on lock screens.
 *
 * Devotees do not sign in, so no message points at a sign-in or settings page:
 * links go to public pages (/, /contact, /sevas, /events, and for an online
 * payment its own receipt or result page, whose link carries an access token
 * the payments module adds), and "to change
 * your details, call the temple office" is how a family updates anything. The
 * "stop updates" line an update carries on WhatsApp and SMS, and the email's
 * unsubscribe link, are added when the message is sent (queue.php), so the
 * wording here never has to include them.
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

    /* ── Family registration ─────────────────────────────────────────────── */

    // Sent only to a family that ticked "send me temple updates", once. It must
    // read naturally whether the registrant added no family members (familyCount
    // 1) or several, so the count stands on a labelled line of its own rather
    // than inside a sentence that would need "person" or "people".
    $t['registration_received'] = [
        'category'    => 'general',
        'description' => 'Sent once when a family registers on the website and agrees to temple updates. familyCount is the number of people in the registration, counting the registrant (1 when no family members were added).',
        'variables'   => ['devoteeName', 'familyCount', 'ctaUrl'],
        'cta_path'    => '/',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'கோயிலில் பதிவு செய்ததற்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{templeName}}-இல் பதிவு செய்ததற்கு மனமார்ந்த நன்றி. உங்கள் விவரங்கள் எங்களுக்குக் கிடைத்தன.\n\nஇந்தப் பதிவில் உள்ள நபர்கள்: {{familyCount}}\n\nஇனி திருவிழா, பூஜை மற்றும் கோயில் அறிவிப்புகளை நீங்கள் தேர்ந்தெடுத்த மொழியில் அனுப்புவோம். ஒவ்வொரு செய்தியிலும் அவற்றை நிறுத்துவதற்கான இணைப்பு இருக்கும்.\n\nபின்னர் விவரங்களை மாற்ற, கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.\n\nகுலதெய்வங்களின் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் என்றும் துணை நிற்கட்டும்.\n\n$signTa",
                    'cta_label' => 'கோயில் இணையதளம்',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: வணக்கம் {{devoteeName}}, கோயிலில் பதிவு செய்ததற்கு நன்றி. திருவிழா, பூஜை செய்திகளை அனுப்புவோம்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}} 🙏\n\n*{{templeName}}*-இல் பதிவு செய்ததற்கு நன்றி.\n\n*இந்தப் பதிவில் உள்ள நபர்கள்:* {{familyCount}}\n\nதிருவிழா, பூஜை மற்றும் கோயில் அறிவிப்புகளை உங்களுக்கு அனுப்புவோம். பின்னர் விவரங்களை மாற்ற {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for registering with the temple',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you for registering with {{templeName}}. We have received your details.\n\nPeople in this registration: {{familyCount}}\n\nFrom now on we will send you news of festivals, poojas and temple announcements in the language you chose. Every message has a link to stop them.\n\nTo change your details later, call the temple office on {{supportPhone}}.\n\nMay the blessings of our kula deivams be with you and your family always.\n\n$signEn",
                    'cta_label' => 'Visit the temple website',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: Vanakkam {{devoteeName}}, thank you for registering with the temple. We will send you festival and pooja news.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}} 🙏\n\nThank you for registering with *{{templeName}}*.\n\n*People in this registration:* {{familyCount}}\n\nWe will send you news of festivals, poojas and temple announcements. To change your details later, call {{supportPhone}}.",
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை கோரிக்கை பெறப்பட்டது: {{sevaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{bookingDate}} அன்று {{sevaName}} சேவைக்கான உங்கள் கோரிக்கை பெறப்பட்டது. உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nகோயில் அலுவலகம் விரைவில் உங்களைத் தொடர்பு கொண்டு, பெரும்பாலும் தொலைபேசியில், உறுதி செய்யும். உறுதியானதும் மீண்டும் தெரிவிக்கிறோம்.\n\nசந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை உறுதியானது: {{sevaName}}, {{bookingDate}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{bookingDate}} அன்று உங்கள் {{sevaName}} சேவை உறுதி செய்யப்பட்டது. உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nசற்று முன்னதாக வந்து, கோயில் அலுவலகத்தில் உங்கள் பதிவு எண்ணைத் தெரிவிக்கவும். கோயிலில் உங்களைச் சந்திக்கக் காத்திருக்கிறோம்.\n\nமாற்றவோ ரத்து செய்யவோ, கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவை பதிவு மாற்றப்பட்டது: {{sevaName}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{sevaName}} சேவைக்கான உங்கள் பதிவு ({{bookingNumber}}) மாற்றப்பட்டுள்ளது.\n\nமாற்றம்: {{changes}}\nதேதி: {{bookingDate}}\n\nஇதில் ஏதேனும் தவறு இருந்தால், கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நினைவூட்டல்: நாளை {{sevaName}} சேவை',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் {{sevaName}} சேவை நாளை, {{bookingDate}} அன்று நடைபெறும். உங்கள் பதிவு எண்: {{bookingNumber}}.\n\nகோயில் முகவரி: {{templeAddress}}\nவழி: {{mapsUrl}}\n\nசற்று முன்னதாக வாருங்கள். வர இயலவில்லை என்றால், கோயில் அலுவலகத்திற்கு {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் நன்கொடைக்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nநன்றி. {{donationPurpose}} நோக்கத்திற்கான உங்கள் {{donationAmount}} நன்கொடை பதிவு செய்யப்பட்டது (குறிப்பு எண் {{receiptNumber}}).\n\nநன்கொடை வந்து சேர்ந்ததும் கோயில் கமிட்டியார் ரசீது அனுப்புவார்கள். முழு அஞ்சல் முகவரி கோயில் அலுவலகத்திடம் இருந்தால் மட்டுமே ரசீது அனுப்ப முடியும்; முகவரி மாறியிருந்தால் {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.\n\nகுலதெய்வங்களின் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: நன்றி. உங்கள் {{donationAmount}} நன்கொடை பதிவு செய்யப்பட்டது. குறிப்பு எண் {{receiptNumber}}.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் நன்கொடைக்கு நன்றி 🙏\n\n*தொகை:* {{donationAmount}}\n*நோக்கம்:* {{donationPurpose}}\n*குறிப்பு எண்:* {{receiptNumber}}\n\nநன்கொடை வந்து சேர்ந்ததும் ரசீது அனுப்பப்படும். முகவரி மாறியிருந்தால் {{supportPhone}} என்ற எண்ணில் தெரிவிக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for your offering',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you. Your offering of {{donationAmount}} towards {{donationPurpose}} has been recorded (reference {{receiptNumber}}).\n\nThe temple committee will send your receipt once the offering is received. A receipt can only be sent when the temple office has your full postal address, so if it has changed, please call {{supportPhone}}.\n\nMay the blessings of our kula deivams be with you and your family.",
                    'cta_label' => 'Contact the temple',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: thank you. Your offering of {{donationAmount}} for {{donationPurpose}} is recorded (ref {{receiptNumber}}). Receipt to follow.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nThank you for your offering 🙏\n\n*Amount:* {{donationAmount}}\n*Purpose:* {{donationPurpose}}\n*Reference:* {{receiptNumber}}\n\nYour receipt will follow once the offering is received. If your postal address has changed, please call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['donation_receipt'] = [
        'category'    => 'donation',
        'description' => 'The receipt for a donation, sent by the committee from Admin → Donations. trustName and taxNote are filled in from the Trust registration automatically.',
        'variables'   => ['devoteeName', 'receiptNumber', 'donationAmount', 'donationPurpose', 'donationDate', 'trustName', 'taxNote', 'ctaUrl'],
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'நன்கொடை ரசீது {{receiptNumber}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{trustName}}-க்கு நீங்கள் வழங்கிய நன்கொடைக்கான ரசீதை நன்றியுடன் அனுப்புகிறோம்.\n\nரசீது எண்: {{receiptNumber}}\nதொகை: {{donationAmount}}\nநோக்கம்: {{donationPurpose}}\nதேதி: {{donationDate}}\n\n{{taxNote}}\n\nஉங்கள் பதிவுகளுக்காக இந்தச் செய்தியைப் பாதுகாத்து வையுங்கள். அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.\n\n$signTa",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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

    /* Online payments (docs/payments/SPEC.md §6). The payments module sends these
     * to a guest recipient once the payment is recorded. Its cta_url is the
     * devotee's own receipt link (/payment/receipt?ref=…&t=…) or result page, so
     * cta_path below is only what an admin preview shows; and the email gets the
     * full breakdown as its details table, so the email wording names only what a
     * devotee needs to read. Never "account" here: a refund goes back to "the
     * card, UPI app or bank you paid with". */

    $t['donation_paid'] = [
        'category'    => 'donation',
        'description' => 'Sent when an online donation is paid. paymentReference is the Donation ID (DON-…); paymentAmount is formatted with its currency ("Rs. 1,001", "USD 25.00"); paymentFor is the donation purpose; paymentDate is the payment date (IST); paymentMode is how it was paid ("UPI", "Credit Card"); ctaUrl is the donor\'s receipt link. trustName and taxNote are filled in from the Trust registration automatically.',
        'variables'   => ['devoteeName', 'receiptNumber', 'paymentReference', 'paymentAmount', 'paymentFor', 'paymentDate', 'paymentMode', 'trustName', 'taxNote', 'ctaUrl'],
        'cta_path'    => '/payment/receipt',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'உங்கள் நன்கொடைக்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nஉங்கள் நன்கொடைக்கு மனமார்ந்த நன்றி. {{paymentFor}} நோக்கத்திற்கான உங்கள் {{paymentAmount}} நன்கொடை {{paymentDate}} அன்று பெறப்பட்டது.\n\nரசீது எண்: {{receiptNumber}}. நன்கொடை எண்: {{paymentReference}}. {{trustName}} வழங்கும் உங்கள் ரசீதைக் கீழே உள்ள இணைப்பில் பார்க்கலாம், பதிவிறக்கலாம் அல்லது அச்சிடலாம். உங்கள் பதிவுகளுக்காக அதைப் பாதுகாத்து வையுங்கள்.\n\n{{taxNote}}\n\nஅருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் என்றும் துணை நிற்கட்டும்.\n\n$signTa",
                    'cta_label' => 'ரசீதைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{paymentAmount}} நன்கொடைக்கு நன்றி. நன்கொடை எண் {{paymentReference}}. ரசீது: {{ctaUrl}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் நன்கொடைக்கு மனமார்ந்த நன்றி 🙏\n\n*ரசீது எண்:* {{receiptNumber}}\n*நன்கொடை எண்:* {{paymentReference}}\n*தொகை:* {{paymentAmount}}\n*நோக்கம்:* {{paymentFor}}\n*தேதி:* {{paymentDate}}\n*கட்டண முறை:* {{paymentMode}}\n\n{{trustName}}\n{{taxNote}}\n\nஉங்கள் ரசீதைப் பாதுகாத்து வையுங்கள். குலதெய்வங்களின் அருள் உங்களுக்கும் உங்கள் குடும்பத்திற்கும் துணை நிற்கட்டும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Thank you for your donation',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you for your donation. Your offering of {{paymentAmount}} towards {{paymentFor}} was received on {{paymentDate}}.\n\nYour receipt number is {{receiptNumber}} and your Donation ID is {{paymentReference}}. You can view, download or print your receipt from the {{trustName}} using the link below. Please keep it for your records.\n\n{{taxNote}}\n\nMay the blessings of Arulmigu Sri Lingammal, Sri Renukadevi and Sri Chinnammal be with you and your family always.\n\n$signEn",
                    'cta_label' => 'View receipt',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => 'Thank you for your contribution of {{paymentAmount}}. Your Donation ID is {{paymentReference}}. Receipt: {{ctaUrl}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nThank you for your donation 🙏\n\n*Receipt no.:* {{receiptNumber}}\n*Donation ID:* {{paymentReference}}\n*Amount:* {{paymentAmount}}\n*Purpose:* {{paymentFor}}\n*Date:* {{paymentDate}}\n*Payment mode:* {{paymentMode}}\n\n{{trustName}}\n{{taxNote}}\n\nPlease keep your receipt for your records. May the blessings of our kula deivams be with you and your family.",
                ],
            ],
        ],
    ];

    $t['payment_success'] = [
        'category'    => 'payment',
        'description' => 'Sent when an online payment for a seva booking succeeds. paymentFor is the seva name; paymentReference is the Booking ID (SEV-…); bookingDate is the preferred date, or "date to be confirmed"; paymentDate is the payment date (IST); ctaUrl is the receipt link. The booking stays pending until the temple office calls to confirm the date.',
        'variables'   => ['devoteeName', 'receiptNumber', 'paymentReference', 'paymentAmount', 'paymentFor', 'bookingDate', 'paymentDate', 'paymentMode', 'ctaUrl'],
        'cta_path'    => '/payment/receipt',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'சேவைக் கட்டணம் பெறப்பட்டது: {{paymentFor}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\nநன்றி. {{paymentFor}} சேவைக்கான உங்கள் {{paymentAmount}} கட்டணம் {{paymentDate}} அன்று பெறப்பட்டது.\n\nபதிவு எண்: {{paymentReference}}. ரசீது எண்: {{receiptNumber}}.\n\nநீங்கள் விரும்பிய தேதி: {{bookingDate}}\n\nசேவை தேதியை உறுதி செய்ய கோயில் அலுவலகம் விரைவில் உங்களைத் தொலைபேசியில் அழைக்கும்; அதன் பிறகே உங்கள் சேவை பதிவு உறுதியாகும். கீழே உள்ள இணைப்பில் உங்கள் ரசீதைப் பார்க்கலாம், பதிவிறக்கலாம் அல்லது அச்சிடலாம்.\n\nசந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'ரசீதைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: {{paymentFor}} சேவைக்கான {{paymentAmount}} கட்டணம் பெறப்பட்டது. தேதியை உறுதி செய்ய கோயில் அலுவலகம் அழைக்கும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் சேவைக் கட்டணம் *பெறப்பட்டது*. நன்றி 🙏\n\n*சேவை:* {{paymentFor}}\n*தொகை:* {{paymentAmount}}\n*பதிவு எண்:* {{paymentReference}}\n*ரசீது எண்:* {{receiptNumber}}\n*விரும்பிய தேதி:* {{bookingDate}}\n*செலுத்திய தேதி:* {{paymentDate}}\n*கட்டண முறை:* {{paymentMode}}\n\nசேவை தேதியை உறுதி செய்ய கோயில் அலுவலகம் விரைவில் உங்களை அழைக்கும். சந்தேகங்களுக்கு {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Seva payment received: {{paymentFor}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nThank you. Your payment of {{paymentAmount}} for {{paymentFor}} seva was received on {{paymentDate}}.\n\nYour Booking ID is {{paymentReference}} and your receipt number is {{receiptNumber}}.\n\nPreferred date: {{bookingDate}}\n\nThe temple office will call you shortly to confirm the date of your seva; your booking is confirmed once they have spoken with you. You can view, download or print your receipt from the link below.\n\nQuestions? Call the temple office on {{supportPhone}}.",
                    'cta_label' => 'View receipt',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: payment of {{paymentAmount}} for {{paymentFor}} seva received. Booking {{paymentReference}}. The office will call you to confirm the date.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour seva payment has been *received*. Thank you 🙏\n\n*Seva:* {{paymentFor}}\n*Amount:* {{paymentAmount}}\n*Booking ID:* {{paymentReference}}\n*Receipt no.:* {{receiptNumber}}\n*Preferred date:* {{bookingDate}}\n*Paid on:* {{paymentDate}}\n*Payment mode:* {{paymentMode}}\n\nThe temple office will call you shortly to confirm the date. Questions? Call {{supportPhone}}.",
                ],
            ],
        ],
    ];

    $t['payment_failed'] = [
        'category'    => 'payment',
        'description' => 'Sent by email when an online payment attempt fails. paymentReference is that attempt\'s order ID; reason is the gateway\'s message in plain words; ctaUrl is the payment result page, which offers Try again.',
        'variables'   => ['devoteeName', 'paymentReference', 'paymentAmount', 'paymentFor', 'reason', 'ctaUrl'],
        'cta_path'    => '/payment/result',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'கட்டணம் நிறைவடையவில்லை: {{paymentAmount}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{paymentFor}} நோக்கத்திற்கான உங்கள் {{paymentAmount}} கட்டணம் நிறைவடையவில்லை. இதற்காக உங்களிடமிருந்து பணம் எதுவும் எடுக்கப்படவில்லை.\n\nகாரணம்: {{reason}}\nகட்டணக் குறிப்பு எண்: {{paymentReference}}\n\nகீழே உள்ள இணைப்பில் மீண்டும் முயற்சிக்கலாம். பாதுகாப்பான கட்டணப் பக்கத்தில் UPI, கார்டு அல்லது நெட் பேங்கிங் மூலம் செலுத்தலாம்.\n\nஇந்தத் தொகை எடுக்கப்பட்டதாக உங்கள் வங்கி காட்டினால் கவலை வேண்டாம்; அது பொதுவாக 5 முதல் 7 வேலை நாட்களுக்குள் தானாகவே உங்களுக்குத் திரும்ப வரும். அதற்குள் வரவில்லை என்றால், மேலே உள்ள குறிப்பு எண்ணுடன் கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'மீண்டும் முயற்சிக்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் {{paymentAmount}} கட்டணம் நிறைவடையவில்லை. பணம் எடுக்கப்பட்டிருந்தால் வங்கி தானாகத் திருப்பி அளிக்கும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் கட்டணம் *நிறைவடையவில்லை*. பணம் எதுவும் எடுக்கப்படவில்லை.\n\n*தொகை:* {{paymentAmount}}\n*எதற்கு:* {{paymentFor}}\n*காரணம்:* {{reason}}\n*குறிப்பு எண்:* {{paymentReference}}\n\nநீங்கள் விரும்பும்போது மீண்டும் முயற்சிக்கலாம். இந்தத் தொகை எடுக்கப்பட்டதாக உங்கள் வங்கி காட்டினால், அது பொதுவாக 5 முதல் 7 வேலை நாட்களுக்குள் தானாகத் திரும்ப வரும். உதவிக்கு {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Payment not completed: {{paymentAmount}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nYour payment of {{paymentAmount}} for {{paymentFor}} did not go through. No money was taken for it.\n\nReason: {{reason}}\nPayment reference: {{paymentReference}}\n\nYou can try again from the link below. On the secure payment page you can pay by UPI, card or net banking.\n\nIf your bank shows a debit for this payment, please do not worry: it will be returned to you automatically, usually within 5 to 7 working days. If it has not come back by then, call the temple office on {{supportPhone}} with the reference above.",
                    'cta_label' => 'Try again',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: your payment of {{paymentAmount}} for {{paymentFor}} did not go through. Any debit will be returned by your bank. Help: {{supportPhone}}',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour payment *did not go through*. No money was taken.\n\n*Amount:* {{paymentAmount}}\n*For:* {{paymentFor}}\n*Reason:* {{reason}}\n*Reference:* {{paymentReference}}\n\nYou can try again whenever you are ready. If your bank shows a debit, it will be returned automatically, usually within 5 to 7 working days. Help: {{supportPhone}}",
                ],
            ],
        ],
    ];

    $t['payment_refund'] = [
        'category'    => 'payment',
        'description' => 'Sent when a refund of an online payment succeeds. refundAmount is formatted with its currency; paymentReference is the Donation or Booking ID; refundReference is the temple\'s refund reference (RF…); ctaUrl is the receipt link, which shows the refund.',
        'variables'   => ['devoteeName', 'refundAmount', 'paymentReference', 'receiptNumber', 'refundReference', 'paymentFor', 'ctaUrl'],
        'cta_path'    => '/payment/receipt',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'தொகை திருப்பி அனுப்பப்பட்டது: {{refundAmount}}',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{paymentFor}} நோக்கத்திற்காக நீங்கள் செலுத்திய கட்டணத்திலிருந்து {{refundAmount}} உங்களுக்குத் திருப்பி அனுப்பப்பட்டுள்ளது. இந்தத் தொகை கோயிலின் கட்டண நுழைவாயிலான CCAvenue மூலம் அனுப்பப்பட்டுள்ளது.\n\nதிருப்பி அனுப்பிய குறிப்பு எண்: {{refundReference}}\nகட்டணக் குறிப்பு எண்: {{paymentReference}}\nரசீது எண்: {{receiptNumber}}\n\nநீங்கள் பணம் செலுத்திய அதே முறைக்கு (கார்டு, UPI அல்லது வங்கி) இந்தத் தொகை பொதுவாக 5 முதல் 7 வேலை நாட்களுக்குள் வந்து சேரும்; இது உங்கள் வங்கியைப் பொறுத்தது. திருப்பி அனுப்பிய விவரத்துடன் புதுப்பிக்கப்பட்ட ரசீதைக் கீழே உள்ள இணைப்பில் பார்க்கலாம்.\n\n7 வேலை நாட்களுக்குப் பிறகும் வந்து சேரவில்லை என்றால், திருப்பி அனுப்பிய குறிப்பு எண்ணுடன் கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'ரசீதைப் பார்க்க',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: உங்கள் {{refundAmount}} திருப்பி அனுப்பப்பட்டது ({{paymentReference}}). 5-7 வேலை நாட்களில் வந்து சேரும்.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "வணக்கம் {{devoteeName}},\n\nஉங்கள் தொகை *திருப்பி அனுப்பப்பட்டது*.\n\n*திருப்பிய தொகை:* {{refundAmount}}\n*எதற்கு:* {{paymentFor}}\n*கட்டணக் குறிப்பு எண்:* {{paymentReference}}\n*ரசீது எண்:* {{receiptNumber}}\n*திருப்பி அனுப்பிய குறிப்பு எண்:* {{refundReference}}\n\nநீங்கள் பணம் செலுத்திய அதே முறைக்கு இது பொதுவாக 5 முதல் 7 வேலை நாட்களுக்குள் வந்து சேரும். அதற்குள் வரவில்லை என்றால் {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                ],
            ],
            'en' => [
                'any' => [
                    'title'     => 'Refund processed: {{refundAmount}}',
                    'body'      => "Vanakkam {{devoteeName}},\n\nWe have processed a refund of {{refundAmount}} for your payment towards {{paymentFor}}. The refund has been sent to CCAvenue, the temple's payment gateway.\n\nRefund reference: {{refundReference}}\nPayment reference: {{paymentReference}}\nReceipt number: {{receiptNumber}}\n\nThe money usually reaches your original payment method (the card, UPI app or bank you paid with) within 5 to 7 working days, depending on your bank. Your receipt, which now shows the refund, is at the link below.\n\nIf the refund has not arrived after 7 working days, call the temple office on {{supportPhone}} with the refund reference.",
                    'cta_label' => 'View receipt',
                ],
                'sms' => [
                    'title' => '',
                    'body'  => '{{templeShortName}}: refund of {{refundAmount}} for {{paymentReference}} processed. It usually reaches your original payment method in 5-7 working days.',
                ],
                'whatsapp' => [
                    'title' => '',
                    'body'  => "Vanakkam {{devoteeName}},\n\nYour refund has been *processed*.\n\n*Refund amount:* {{refundAmount}}\n*For:* {{paymentFor}}\n*Payment reference:* {{paymentReference}}\n*Receipt no.:* {{receiptNumber}}\n*Refund reference:* {{refundReference}}\n\nIt usually reaches your original payment method within 5 to 7 working days. If it has not arrived by then, call {{supportPhone}}.",
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
        'cta_path'    => '/contact',
        'langs' => [
            'ta' => [
                'any' => [
                    'title'     => 'தன்னார்வ சேவைக்கு நன்றி',
                    'body'      => "வணக்கம் {{devoteeName}},\n\n{{opportunityName}} பணியில் தன்னார்வலராகச் சேவை செய்ய முன்வந்ததற்கு மனமார்ந்த நன்றி. உங்கள் நேரமும் உழைப்பும் கோயிலுக்குப் பெரும் துணை.\n\nகமிட்டி உறுப்பினர் ஒருவர் விவரங்களுடன் உங்களைத் தொடர்பு கொள்வார். சந்தேகங்களுக்கு கோயில் அலுவலகத்தை {{supportPhone}} என்ற எண்ணில் அழைக்கவும்.",
                    'cta_label' => 'கோயிலைத் தொடர்பு கொள்ள',
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
                    'cta_label' => 'Contact the temple',
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
        'description' => 'An emergency notice (closure, safety, weather), sent to every family who agreed to temple updates.',
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
