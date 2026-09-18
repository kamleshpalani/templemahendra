<?php
// backend/includes/site_pages.php
//
// What a shared link should say about each page of the public site.
//
// WHY THIS FILE EXISTS
// The site is a React app: its <Seo> component writes the title, description and
// Open Graph tags into the document after the JavaScript runs. WhatsApp,
// Facebook, LinkedIn and X never run JavaScript — they read the HTML the server
// returns — so without a server-side answer every shared link previews as the
// raw index.html and every page looks identical.
//
// api/og.php answers those crawlers, and this is where it gets the words.
//
// KEEPING IT IN STEP WITH THE PAGES
// These strings are the same ones each page passes to <Seo>. Two copies of a
// sentence is exactly the kind of thing that drifts, so tests/og.mjs loads every
// route in a real browser, reads the og:title and og:description React rendered,
// and fails if they do not match what this table returns for the same path.
// Change a page's title or lead and that test tells you to change it here.
//
// Content that lives in a table (a seva, a photograph) is NOT listed here:
// og.php reads those from the database, so they need no second copy.

/**
 * path => [title_ta, title_en, desc_ta, desc_en]
 *
 * The path is exactly what the browser shows, with no query string. '/' is the
 * home page, whose title is the temple's name on its own — see og.php.
 */
function sitePages(): array
{
    return [
        '/' => [
            '', '',
            'பக்தி, பாரம்பரியம் மற்றும் சமூகம் — ஒரு புனிதத் தலம்',
            'A sacred place of devotion, tradition, and community',
        ],
        '/about' => [
            'பற்றி', 'About',
            'தப்பலவார் குலதெய்வம் அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
            'Dhabbalavaar Kula Deivam — Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple',
        ],
        '/sevas' => [
            'சேவைகள்', 'Sevas',
            'உங்கள் பெயரில் அல்லது குடும்பத்தினர் பெயரில் ஒரு பூஜையை நடத்தி ஆசி பெறுங்கள்.',
            "Offer a pooja in your name or your family's name and receive the blessings of the Goddess.",
        ],
        '/events' => [
            'நிகழ்வுகள்', 'Events',
            'பவுர்ணமி பூஜைகள், திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகள் — ஒரே இடத்தில்.',
            'Pournami poojas, festivals and special occasions — all in one place.',
        ],
        '/gallery' => [
            'தொகுப்பு', 'Gallery',
            'திருவிழாக்கள், பூஜைகள் மற்றும் கோயில் நிகழ்வுகளின் தருணங்கள்.',
            'Moments from festivals, poojas and temple gatherings.',
        ],
        // TRUST.name — the registered trust, in its own deity order.
        '/donations' => [
            'நன்கொடை', 'Donations',
            'அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை',
            'Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust',
        ],
        // ADDRESS.printed — verbatim from the booklet banner.
        '/contact' => [
            'தொடர்பு', 'Contact',
            'புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம் - 627719',
            'Pudupatti, Thiruvengadam Taluk, Tenkasi District – 627719',
        ],
        '/panchangam' => [
            'பஞ்சாங்கம்', 'Panchangam',
            'அமாவாசை · பௌர்ணமி · ஏகாதசி · நல்ல நேரம் · ராகு காலம்',
            'Amavasai · Pournami · Ekadasi · Good Timings · Rahu Kalam',
        ],
        '/search' => [
            'தேடல்', 'Search',
            'சேவைகள், நிகழ்வுகள், பஞ்சாங்கம், அறிவிப்புகள், பக்கங்கள் — எல்லாவற்றிலும் தேடுங்கள்.',
            'Sevas, events, panchangam, notices and pages, all in one place.',
        ],
        // The family registration form (docs/registration/SPEC.md §7). The
        // committee shares this link on WhatsApp, so it previews like any page.
        '/register' => [
            'குடும்பப் பதிவு', 'Family registration',
            'கோயில் உங்கள் குடும்பத்தை அறிந்து கொள்ள, ஒரு முறை மட்டும் இந்தப் படிவத்தை நிரப்புங்கள். கணக்கோ கடவுச்சொல்லோ தேவையில்லை.',
            'Fill this in once so the temple knows your family. No account or password is needed.',
        ],
        // Online giving through CCAvenue (docs/payments/SPEC.md §7.3). /donations
        // keeps the bank details and the pledge form; this is the payment flow.
        '/donate' => [
            'இணையவழி நன்கொடை', 'Donate online',
            'UPI, கார்டு அல்லது நெட் பேங்கிங் மூலம் CCAvenue பாதுகாப்பான பக்கத்தில் திருக்கோவில் தர்ம அறக்கட்டளைக்கு நன்கொடை வழங்கி, மின்னணு ரசீது பெறுங்கள்.',
            "Give to the Temple Dharma Trust by UPI, card or net banking on CCAvenue's secure page, and receive an electronic receipt.",
        ],
        // The four policy pages (SPEC §7.8). Title and lead are the ones in
        // frontend/src/data/policies.js.
        '/privacy-policy' => [
            'தனியுரிமைக் கொள்கை', 'Privacy Policy',
            'நன்கொடை, சேவை பதிவு, இணையவழிப் பணம் செலுத்துதலின்போது நீங்கள் தரும் விவரங்களை அறக்கட்டளை எவ்வாறு பயன்படுத்திப் பாதுகாக்கிறது என்பதை இப்பக்கம் விளக்குகிறது.',
            'How the Temple Dharma Trust collects, uses and protects the details you give when you donate, book a seva or pay online.',
        ],
        '/terms-and-conditions' => [
            'விதிமுறைகள் & நிபந்தனைகள்', 'Terms & Conditions',
            'இந்த இணையதளத்தின் மூலம் அறக்கட்டளைக்கு நன்கொடை வழங்கும்போதும், சேவை பதிவு செய்து பணம் செலுத்தும்போதும் பொருந்தும் விதிமுறைகள்.',
            'The terms that apply when you donate to the Temple Dharma Trust, or book and pay for a seva, through this website.',
        ],
        '/refund-cancellation-policy' => [
            'பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கை', 'Refund & Cancellation Policy',
            'நன்கொடை எப்போது திருப்பி அளிக்கப்படும், சேவை பதிவை எப்படி ரத்து செய்வது, திருப்பி அளிக்கும் பணம் எத்தனை நாட்களில் உங்களை வந்தடையும் என்பதை இங்கே அறியலாம்.',
            'When a donation can be refunded, how to cancel a seva booking, and how long a refund takes to reach you.',
        ],
        '/shipping-delivery-policy' => [
            'அனுப்புதல் & விநியோகக் கொள்கை', 'Shipping & Delivery Policy',
            'அறக்கட்டளை எந்தப் பொருளையும் விற்பதோ அனுப்புவதோ இல்லை. நன்கொடை ரசீதுகள் மின்னணு முறையில் வழங்கப்படுகின்றன; சேவைகள் திருக்கோவிலில் நடைபெறுகின்றன.',
            'The Trust sells and ships no goods. Donation receipts are delivered electronically, and sevas are performed at the temple.',
        ],
        // Live darshan (docs/live/SPEC-PHASE1.md §4.6). The React page passes
        // exactly these strings to <Seo>; tests/og.mjs checks they agree.
        '/live-darshan' => [
            'நேரடி தரிசனம்', 'Live Darshan',
            'கோயிலின் தினசரி பூஜைகள், அபிஷேகம், தீபாராதனை மற்றும் திருவிழாக்களை உலகின் எந்த இடத்திலிருந்தும் நேரடியாகக் காணுங்கள்.',
            'Watch the temple\'s daily poojas, abhishekam, deeparadhana and festivals live from anywhere in the world.',
        ],
        // The schedule (docs/live/SPEC-PHASE2.md §1.3), same rule: pages/LiveSchedule.jsx carries these exact strings.
        '/live-darshan/schedule' => [
            'நேரடி தரிசன அட்டவணை', 'Live Darshan schedule',
            'இன்று, நாளை மற்றும் இந்த வாரத்தின் நேரடி பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழா ஒளிபரப்புகளின் அட்டவணை.',
            'The schedule of live poojas, abhishekams and festival broadcasts for today, tomorrow and this week.',
        ],
        '/live-darshan/archive' => [
            'தரிசனப் பதிவுகள்', 'Darshan recordings',
            'நிறைவடைந்த பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழாக்களின் பதிவுகளைக் காணுங்கள்.',
            'Watch recordings of completed poojas, abhishekams and festivals.',
        ],
    ];
}

// There are no private pages any more. Devotee sign-in was removed, and the
// addresses it used (/login, /account, /notifications, /forgot-password,
// /reset-password, /verify-email) now only redirect to /register in the browser.
// A crawler asking for one of them is told what og.php tells it about any
// address that is not a page of the site: 404, noindex.
