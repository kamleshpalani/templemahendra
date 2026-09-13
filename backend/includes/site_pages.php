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
    ];
}

// There are no private pages any more. Devotee sign-in was removed, and the
// addresses it used (/login, /account, /notifications, /forgot-password,
// /reset-password, /verify-email) now only redirect to /register in the browser.
// A crawler asking for one of them is told what og.php tells it about any
// address that is not a page of the site: 404, noindex.
