/**
 * src/data/policies.js — the four legal pages a payment gateway requires
 * (docs/payments/SPEC.md §7.8): Privacy, Terms & Conditions, Refund &
 * Cancellation, and Shipping & Delivery. Rendered by pages/Policy.jsx.
 *
 * Every fact about the Trust (name, registration, PAN, address, phones, email)
 * comes from data/temple.js, so a change there reaches these pages too.
 *
 * Shape of one policy:
 *   path          the route, as registered in App.jsx
 *   title {ta,en} the page title; also the <Seo> title and the site_pages.php title
 *   lead  {ta,en} the hero lead; also the <Seo> description
 *   updated       ISO date shown as "Last updated"
 *   glance        [{ta,en}] the few facts most visitors came for
 *   sections      [{ id, nav{ta,en}, heading{ta,en}, blocks }]
 *                 blocks: { type:"p", ta, en } | { type:"ul"|"ol", items:[{ta,en}] }
 *                         | { type:"links", items:[{ to, ta, en }] }
 *   contactIntro  {ta,en} the sentence above the shared contact card
 *
 * KEEP IN STEP: title and lead are copied into backend/includes/site_pages.php
 * (what WhatsApp and other crawlers see) and the titles into
 * backend/api/search.php. tests/og.mjs fails when the copies disagree.
 *
 * These are drafts written from the site's own facts; the committee approves
 * the wording before going live (SPEC §14, item 13).
 */
import { TRUST, ADDRESS } from "./temple";

const REG = TRUST.bank.regNo;
const REG_DATE = TRUST.bank.regDate;
const PAN = TRUST.bank.pan;

const p = (ta, en) => ({ type: "p", ta, en });
const ul = (...items) => ({ type: "ul", items });
const ol = (...items) => ({ type: "ol", items });
const li = (ta, en) => ({ ta, en });
const links = (...items) => ({ type: "links", items });

/** Paths of the four pages, for cross-links inside the text. */
export const POLICY_PATHS = {
  privacy: "/privacy-policy",
  terms: "/terms-and-conditions",
  refunds: "/refund-cancellation-policy",
  shipping: "/shipping-delivery-policy",
};

/** The order the pages are listed in (footer, "Other policies"). */
export const POLICY_ORDER = ["privacy", "terms", "refunds", "shipping"];

const REFUND_LINK = {
  to: POLICY_PATHS.refunds,
  ta: "பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கை",
  en: "Refund & Cancellation Policy",
};

export const POLICIES = {
  /* ── Privacy ─────────────────────────────────────────────────────────── */
  privacy: {
    path: POLICY_PATHS.privacy,
    title: { ta: "தனியுரிமைக் கொள்கை", en: "Privacy Policy" },
    lead: {
      ta: "நன்கொடை, சேவை பதிவு, இணையவழிப் பணம் செலுத்துதலின்போது நீங்கள் தரும் விவரங்களை அறக்கட்டளை எவ்வாறு பயன்படுத்திப் பாதுகாக்கிறது என்பதை இப்பக்கம் விளக்குகிறது.",
      en: "How the Temple Dharma Trust collects, uses and protects the details you give when you donate, book a seva or pay online.",
    },
    updated: "2026-09-14",
    glance: [
      li(
        "உங்கள் கார்டு, UPI, நெட் பேங்கிங் விவரங்கள் CCAvenue பாதுகாப்பான பக்கத்தில் மட்டுமே உள்ளிடப்படுகின்றன; அவை எங்களை வந்தடைவதில்லை.",
        "Your card, UPI and net-banking details are entered only on CCAvenue's secure page and never reach us.",
      ),
      li(
        "உங்கள் விவரங்களை நாங்கள் விற்பதோ, வாடகைக்கு விடுவதோ, விளம்பரத்துக்குப் பயன்படுத்துவதோ இல்லை.",
        "We never sell or rent your details, or use them for advertising.",
      ),
      li(
        "நீங்கள் கேட்டால் மட்டுமே உங்கள் பெயர் நன்றிப் பட்டியலில் காட்டப்படும்.",
        "Your name appears on the thank-you list only if you ask for it.",
      ),
      li(
        "பணம் செலுத்திய பதிவுகள் சட்டப்படி குறைந்தது 8 ஆண்டுகள் வைத்திருக்கப்படும்.",
        "Payment records are kept for at least 8 years, as the law requires.",
      ),
    ],
    sections: [
      {
        id: "who-we-are",
        nav: { ta: "நாங்கள் யார்", en: "Who we are" },
        heading: { ta: "நாங்கள் யார்", en: "Who we are" },
        blocks: [
          p(
            `இந்த இணையதளத்தை ${TRUST.name.ta} (பதிவு எண் ${REG}, நாள் ${REG_DATE}; பான் ${PAN}) நடத்துகிறது. முகவரி: ${ADDRESS.oneLine.ta}. இக்கொள்கையில் “அறக்கட்டளை”, “நாங்கள்” என்பவை இந்த அறக்கட்டளையைக் குறிக்கும்.`,
            `This website is run by the ${TRUST.name.en} (Registration No. ${REG}, dated ${REG_DATE}; PAN ${PAN}), ${ADDRESS.oneLine.en}. In this policy, “the Trust”, “we” and “us” mean this Trust.`,
          ),
          p(
            "இணையதளத்தில் நீங்கள் நன்கொடை வழங்கும்போதும், சேவை பதிவு செய்யும்போதும், குடும்பத்தைப் பதிவு செய்யும்போதும், எங்களுக்குச் செய்தி அனுப்பும்போதும் தரும் விவரங்களுக்கு இக்கொள்கை பொருந்தும்.",
            "It applies to the details you give on this website when you donate, book a seva, register your family or send us a message.",
          ),
        ],
      },
      {
        id: "what-we-collect",
        nav: { ta: "சேகரிக்கும் விவரங்கள்", en: "What we collect" },
        heading: { ta: "நாங்கள் சேகரிக்கும் விவரங்கள்", en: "What we collect" },
        blocks: [
          p("நீங்கள் நன்கொடை வழங்கும்போது அல்லது சேவைக்குப் பணம் செலுத்தும்போது:", "When you donate or pay for a seva:"),
          ul(
            li("உங்கள் முழுப் பெயர், தொலைபேசி எண், நாடு.", "Your full name, phone number and country."),
            li(
              "நீங்கள் விரும்பினால் மட்டும்: மின்னஞ்சல், அஞ்சல் முகவரி (ஊர், மாநிலம், அஞ்சல் குறியீடு உட்பட), பான் எண், அலுவலகத்திற்கான செய்தி அல்லது குறிப்பு.",
              "Only if you choose to give them: your email, postal address (with city, state and PIN or postal code), PAN, and a message or note for the office.",
            ),
            li(
              "நன்கொடையின் நோக்கம், தொகை, நாணயம்; நீங்கள் பதிவு செய்யும் சேவையும் நீங்கள் விரும்பும் தேதியும்.",
              "The purpose, amount and currency of your donation; the seva you book and your preferred date.",
            ),
            li(
              "நன்றிப் பட்டியலில் உங்கள் பெயரைக் காட்டலாமா என்ற உங்கள் விருப்பம்.",
              "Whether you want your name shown on the thank-you list.",
            ),
            li(
              "பணம் செலுத்திய பின் CCAvenue அனுப்பும் முடிவு: பணம் செலுத்தியதன் நிலை, CCAvenue குறிப்பு எண், வங்கிக் குறிப்பு எண், பணம் செலுத்திய முறை (எ.கா. UPI அல்லது கார்டு வகை), தேதி, நேரம்.",
              "What CCAvenue sends back after you pay: the payment status, the CCAvenue reference number, the bank reference number, the payment method (for example UPI or the card type), and the date and time.",
            ),
          ),
          p(
            "குடும்பப் பதிவில்: நீங்கள் உள்ளிடும் பெயர், தொலைபேசி, மின்னஞ்சல், பிறந்த தேதி, முகவரி, ஒவ்வொரு குடும்ப உறுப்பினரின் பெயர், உறவுமுறை, வயது. தொடர்பு படிவத்தில்: உங்கள் பெயர், தொலைபேசி, செய்தி.",
            "For family registration: the name, phone number, email, date of birth and address you enter, and each family member's name, relationship and age. For the contact form: your name, phone number and message.",
          ),
          p(
            "இணையதளத்தைத் தவறாகப் பயன்படுத்துவதைத் தடுக்க, ஒவ்வொரு படிவச் சமர்ப்பிப்பு மற்றும் பணம் செலுத்தும் கோரிக்கையின் IP முகவரியும் நேரமும் பதிவாகின்றன.",
            "To stop misuse, we record the IP address and time of each form submission and payment request.",
          ),
        ],
      },
      {
        id: "how-we-use",
        nav: { ta: "பயன்பாடு", en: "How we use it" },
        heading: { ta: "விவரங்களை எதற்காகப் பயன்படுத்துகிறோம்", en: "How we use your details" },
        blocks: [
          ul(
            li(
              "உங்கள் பணத்தை CCAvenue மூலம் பெறவும், அது வெற்றிகரமாக வந்ததா என்று உறுதி செய்யவும்.",
              "To take your payment through CCAvenue and confirm that it succeeded.",
            ),
            li(
              "ரசீது வழங்கி, அதை மின்னஞ்சல், SMS அல்லது வாட்ஸ்அப் மூலம் உங்களுக்கு அனுப்பவும்.",
              "To issue your receipt and send it to you by email, SMS or WhatsApp.",
            ),
            li(
              "80G வருமான வரிச்சலுகைக்குத் தேவையான விவரங்களைப் பதிவு செய்யவும் (இதற்கு உங்கள் பான் எண், பெயர், முகவரி தேவைப்படலாம்).",
              "To record the details needed for the 80G income-tax exemption (your PAN, name and address may be needed for this).",
            ),
            li(
              "சேவையின் தேதியை உறுதி செய்ய உங்களைத் தொடர்பு கொள்ளவும்.",
              "To call you to confirm the date of a seva booking.",
            ),
            li(
              "உங்கள் கேள்விகளுக்கும் பணம் திருப்பக் கோரிக்கைகளுக்கும் பதில் அளிக்கவும்.",
              "To answer your questions and refund requests.",
            ),
            li(
              "அறக்கட்டளையின் வரவு-செலவு மற்றும் தணிக்கைப் பதிவுகளைச் சட்டப்படி பராமரிக்கவும்.",
              "To keep the Trust's accounts and audit records as the law requires.",
            ),
          ),
          p(
            "உங்கள் விவரங்களை விளம்பரத்துக்குப் பயன்படுத்துவதில்லை. திருக்கோவில் அறிவிப்புகள், குடும்பப் பதிவின்போது அவற்றைப் பெற ஒப்புதல் அளித்தவர்களுக்கு மட்டுமே அனுப்பப்படுகின்றன.",
            "We do not use your details for advertising. Temple announcements are sent only to families who agreed to receive them when they registered.",
          ),
        ],
      },
      {
        id: "card-details",
        nav: { ta: "கார்டு விவரங்கள்", en: "Card details" },
        heading: { ta: "கார்டு, UPI, வங்கி விவரங்கள்", en: "Card, UPI and bank details" },
        blocks: [
          p(
            "கார்டு எண், CVV, காலாவதி தேதி, UPI PIN, நெட் பேங்கிங் கடவுச்சொல் போன்றவற்றை நீங்கள் CCAvenue-இன் PCI-DSS தரச்சான்று பெற்ற பாதுகாப்பான பக்கத்தில் மட்டுமே உள்ளிடுகிறீர்கள். அவை எங்கள் இணையதளத்தின் வழியாகச் செல்வதில்லை; எங்கள் சர்வர்களில் சேமிக்கப்படுவதும் இல்லை. பணம் செலுத்தியதன் முடிவையும் குறிப்பு எண்களையும் மட்டுமே நாங்கள் பெறுகிறோம்.",
            "You enter your card number, CVV, expiry date, UPI PIN or net-banking password only on CCAvenue's PCI-DSS compliant secure page. They never pass through our website and are never stored on our servers. We receive only the outcome of the payment and its reference numbers.",
          ),
        ],
      },
      {
        id: "sharing",
        nav: { ta: "பகிர்வு", en: "Sharing" },
        heading: { ta: "யாருடன் பகிரப்படுகிறது", en: "Who we share it with" },
        blocks: [
          ul(
            li(
              "CCAvenue (எங்கள் பணப் பரிவர்த்தனை நுழைவாயில்) — உங்கள் பணத்தைப் பெற்று உறுதி செய்வதற்காக உங்கள் பெயர், தொலைபேசி, மின்னஞ்சல், முகவரி, தொகை.",
              "CCAvenue, our payment gateway — your name, phone number, email, address and the amount, so it can take and confirm your payment.",
            ),
            li(
              "மின்னஞ்சல், SMS, வாட்ஸ்அப் செய்திச் சேவை வழங்குநர்கள் — ரசீதையும் செய்திகளையும் அனுப்பத் தேவையான பெயர், தொலைபேசி அல்லது மின்னஞ்சல், ரசீது விவரங்கள் மட்டும்.",
              "Our email, SMS and WhatsApp message providers — only the name, phone number or email address and receipt details needed to deliver your receipt and messages.",
            ),
            li(
              "சட்டம் கோரும்போது அரசு அமைப்புகள் — எடுத்துக்காட்டாக, 80G நன்கொடைகள் பற்றி வருமான வரித்துறைக்குச் சமர்ப்பிக்கும் ஆண்டு அறிக்கை.",
              "Government authorities when the law requires it — for example, the annual statement of 80G donations filed with the Income Tax Department.",
            ),
            li(
              "இணையதளத்தின் உதவி அரட்டையில் நீங்கள் தட்டச்சு செய்யும் கேள்விகள், பதில் தயாரிக்க Google-இன் AI சேவைக்கு அனுப்பப்படலாம். அரட்டையில் தனிப்பட்ட அல்லது பண விவரங்களைப் பகிர வேண்டாம்.",
              "Questions you type into the website's help chat may be sent to Google's AI service to prepare an answer. Please do not share personal or payment details in the chat.",
            ),
          ),
          p("உங்கள் விவரங்களை நாங்கள் யாருக்கும் விற்பதோ, வாடகைக்கு விடுவதோ, பரிமாறுவதோ இல்லை.", "We never sell, rent or trade your details."),
        ],
      },
      {
        id: "thank-you-list",
        nav: { ta: "நன்றிப் பட்டியல்", en: "Thank-you list" },
        heading: { ta: "நன்றிப் பட்டியல்", en: "The thank-you list" },
        blocks: [
          p(
            "“கோயிலின் நன்றிப் பட்டியலில் என் பெயரைக் காட்டவும்” என்ற பெட்டியை நீங்கள் தேர்வு செய்தால் மட்டுமே, உங்கள் பெயரும் நன்கொடையின் நோக்கமும் இணையதளத்தில் சுமார் 30 நாட்கள் காட்டப்படும். தொகை, தொலைபேசி எண், முகவரி ஒருபோதும் காட்டப்படாது. பெட்டியைத் தேர்வு செய்யாவிட்டால், உங்கள் நன்கொடை பெயர் குறிப்பிடப்படாமலே இருக்கும்.",
            "Only if you tick “Show my name on the temple's thank-you list” are your name and the purpose of your donation shown on the website, for about 30 days. The amount, your phone number and your address are never shown. If you leave the box unticked, your donation stays anonymous.",
          ),
          p(
            "இணையவழி நன்கொடை, பணம் வெற்றிகரமாகச் செலுத்தப்பட்ட பின்பே பட்டியலில் இடம்பெறும்; திருப்பி அளிக்கப்பட்டால் பட்டியலிலிருந்து நீக்கப்படும்.",
            "An online donation appears only after its payment succeeds, and is removed from the list if it is refunded.",
          ),
        ],
      },
      {
        id: "retention",
        nav: { ta: "வைத்திருக்கும் காலம்", en: "How long we keep it" },
        heading: { ta: "எவ்வளவு காலம் வைத்திருக்கிறோம்", en: "How long we keep it" },
        blocks: [
          ul(
            li(
              "நன்கொடை, பணம் செலுத்துதல், ரசீது, பணம் திருப்புதல் பதிவுகள்: வரவு-செலவு மற்றும் தணிக்கைக்காகச் சட்டம் கோரும் காலம் வரை — குறைந்தது 8 ஆண்டுகள்.",
              "Donation, payment, receipt and refund records: for as long as the law requires for accounts and audit, and at least 8 years.",
            ),
            li(
              "குடும்பப் பதிவு விவரங்கள், பணம் செலுத்தாத சேவைக் கோரிக்கைகள், தொடர்புச் செய்திகள்: நீங்கள் நீக்கக் கேட்கும் வரை, அல்லது திருக்கோவில் அலுவலகத்திற்கு அவை தேவைப்படும் வரை.",
              "Family registration details, unpaid seva requests and contact messages: until you ask us to remove them, or until the temple office no longer needs them.",
            ),
            li(
              "தவறான பயன்பாட்டைத் தடுக்கப் பதிவாகும் IP முகவரிகள்: சில நாட்களில் தானாக நீக்கப்படும்; பணம் செலுத்துதல் பதிவின் பகுதியாக உள்ளவை அந்தப் பதிவுடன் வைக்கப்படும்.",
              "IP addresses recorded to stop misuse: deleted automatically within a few days, except those that form part of a payment's record, which are kept with it.",
            ),
          ),
        ],
      },
      {
        id: "your-choices",
        nav: { ta: "உங்கள் உரிமைகள்", en: "Your choices" },
        heading: { ta: "உங்கள் உரிமைகள்", en: "Your choices" },
        blocks: [
          ul(
            li(
              "உங்களைப் பற்றி நாங்கள் வைத்திருக்கும் விவரங்களைப் பார்க்கவும், தவறுகளைத் திருத்தவும் கேட்கலாம்.",
              "You can ask to see the details we hold about you and to correct anything that is wrong.",
            ),
            li(
              "கட்டாயமில்லாத விவரங்களை — மின்னஞ்சல், செய்தி, குறிப்பு, நன்றிப் பட்டியலில் உங்கள் பெயர் போன்றவற்றை — நீக்கக் கேட்கலாம்.",
              "You can ask us to remove details that are not required, such as your email, message, note or your name on the thank-you list.",
            ),
            li(
              "சட்டப்படி வைத்திருக்க வேண்டிய பணம் செலுத்துதல் மற்றும் ரசீது பதிவுகளை, அக்காலம் முடியும் முன் நீக்க இயலாது.",
              "Payment and receipt records that the law requires us to keep cannot be deleted before that period ends.",
            ),
          ),
          p(
            "கீழே உள்ள தொலைபேசி அல்லது மின்னஞ்சல் மூலம், உங்கள் நன்கொடை எண் அல்லது சேவை பதிவு எண்ணைக் குறிப்பிட்டு எங்களைத் தொடர்பு கொள்ளுங்கள். நீங்கள்தான் என்பதை உறுதி செய்த பின்பே மாற்றங்களைச் செய்வோம்.",
            "Contact us by phone or email using the details below, quoting your Donation ID or Booking ID. We will confirm it is you before making any change.",
          ),
        ],
      },
      {
        id: "cookies",
        nav: { ta: "குக்கீகள்", en: "Cookies" },
        heading: { ta: "குக்கீகளும் சேமிப்பும்", en: "Cookies and storage" },
        blocks: [
          p(
            "பொது இணையதளமும் பணம் செலுத்தும் பக்கங்களும் எந்தக் குக்கீயையும் அமைப்பதில்லை; விளம்பர அல்லது கண்காணிப்புக் குக்கீகளும் இல்லை. நீங்கள் தேர்ந்தெடுத்த மொழியும் முடிக்காத படிவங்களும் உங்கள் சொந்த உலாவியில் மட்டுமே சேமிக்கப்படுகின்றன; உலாவியின் அமைப்புகளில் அவற்றை எப்போது வேண்டுமானாலும் அழிக்கலாம்.",
            "The public website and the payment pages set no cookies, and there are no advertising or tracking cookies. Your language choice and any unfinished form are saved only in your own browser, and you can clear them from your browser settings at any time.",
          ),
          p(
            "கமிட்டி உறுப்பினர்கள் உள்நுழையும் நிர்வாகப் பகுதி மட்டும் ஓர் அமர்வுக் குக்கீயைப் பயன்படுத்துகிறது. தொடர்பு பக்கத்தில் உள்ள வரைபடத்தை Google வழங்குகிறது; அது ஏற்றப்படும்போது Google தனது சொந்தக் குக்கீகளை அமைக்கலாம். CCAvenue-இன் பணம் செலுத்தும் பக்கம் தனது சொந்தக் கொள்கையின்படி குக்கீகளைப் பயன்படுத்தலாம்.",
            "Only the committee's sign-in area uses a session cookie, for signed-in committee members. The map on the Contact page is provided by Google, which may set its own cookies when the map loads, and CCAvenue's payment page may use cookies under its own policy.",
          ),
        ],
      },
      {
        id: "security",
        nav: { ta: "பாதுகாப்பு", en: "Security" },
        heading: { ta: "பாதுகாப்பு", en: "Security" },
        blocks: [
          p(
            "இணையதளம் மறைகுறியாக்கப்பட்ட HTTPS இணைப்பில் இயங்குகிறது. உங்கள் விவரங்களைத் தேவைப்படும் கமிட்டி உறுப்பினர்கள் மட்டுமே பார்க்க முடியும்; அவர்கள் செய்யும் மாற்றங்கள் பதிவு செய்யப்படுகின்றன. ஒவ்வொரு பணம் செலுத்துதலின் நிலை மாற்றமும் தணிக்கைப் பதிவில் சேமிக்கப்படுகிறது.",
            "The website is served over an encrypted HTTPS connection. Only committee members who need your details can see them, and the changes they make are logged. Every change in a payment's status is kept in an audit trail.",
          ),
        ],
      },
      {
        id: "changes",
        nav: { ta: "மாற்றங்கள்", en: "Changes" },
        heading: { ta: "இக்கொள்கையில் மாற்றங்கள்", en: "Changes to this policy" },
        blocks: [
          p(
            "இக்கொள்கையை அவ்வப்போது புதுப்பிக்கலாம். ஒவ்வொரு முறையும் இப்பக்கத்தின் மேலே உள்ள “கடைசியாகப் புதுப்பிக்கப்பட்டது” தேதி மாற்றப்படும்.",
            "We may update this policy from time to time. The “Last updated” date at the top of this page changes whenever we do.",
          ),
        ],
      },
    ],
    contactIntro: {
      ta: "உங்கள் விவரங்களைப் பற்றிக் கேட்க, அவற்றைத் திருத்த அல்லது நீக்கக் கோர:",
      en: "To ask about your details, or to have them corrected or removed:",
    },
  },

  /* ── Terms & Conditions ──────────────────────────────────────────────── */
  terms: {
    path: POLICY_PATHS.terms,
    title: { ta: "விதிமுறைகள் & நிபந்தனைகள்", en: "Terms & Conditions" },
    lead: {
      ta: "இந்த இணையதளத்தின் மூலம் அறக்கட்டளைக்கு நன்கொடை வழங்கும்போதும், சேவை பதிவு செய்து பணம் செலுத்தும்போதும் பொருந்தும் விதிமுறைகள்.",
      en: "The terms that apply when you donate to the Temple Dharma Trust, or book and pay for a seva, through this website.",
    },
    updated: "2026-09-14",
    glance: [
      li(
        "நன்கொடைகள் தன்னார்வமானவை; அவை அறக்கட்டளை மூலம் திருக்கோவில் பணிகளுக்குப் பயன்படுகின்றன.",
        "Donations are voluntary and support the temple's work through the Trust.",
      ),
      li(
        "பணம் CCAvenue மூலம் பெறப்படுகிறது; உறுதியானதும் மின்னணு ரசீது வழங்கப்படும்.",
        "Payments are processed by CCAvenue, and an electronic receipt is issued once a payment is confirmed.",
      ),
      li(
        "சேவைகள் திருக்கோவிலின் அட்டவணைப்படி, அலுவலகம் உறுதி செய்யும் தேதியில் நடைபெறும்.",
        "Sevas take place on the date the temple office confirms, subject to the temple's schedule.",
      ),
      li(
        "இந்தியச் சட்டங்கள் பொருந்தும்; தென்காசி மாவட்ட நீதிமன்றங்களுக்கே அதிகார வரம்பு.",
        "Indian law applies, and the courts of Tenkasi district have jurisdiction.",
      ),
    ],
    sections: [
      {
        id: "about-these-terms",
        nav: { ta: "அறிமுகம்", en: "About these terms" },
        heading: { ta: "இந்த விதிமுறைகள் பற்றி", en: "About these terms" },
        blocks: [
          p(
            `இந்த இணையதளத்தை ${TRUST.name.ta} (பதிவு எண் ${REG}, நாள் ${REG_DATE}; பான் ${PAN}) நடத்துகிறது. இதன் மூலம் நன்கொடை வழங்கும்போதோ, சேவை பதிவு செய்து பணம் செலுத்தும்போதோ, இந்த விதிமுறைகளையும் எங்கள் தனியுரிமைக் கொள்கை, பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கை ஆகியவற்றையும் ஏற்றுக்கொள்கிறீர்கள்.`,
            `This website is run by the ${TRUST.name.en} (Registration No. ${REG}, dated ${REG_DATE}; PAN ${PAN}). By donating, or by booking and paying for a seva through it, you accept these terms together with our Privacy Policy and our Refund & Cancellation Policy.`,
          ),
          links(
            { to: POLICY_PATHS.privacy, ta: "தனியுரிமைக் கொள்கை", en: "Privacy Policy" },
            REFUND_LINK,
          ),
        ],
      },
      {
        id: "donations",
        nav: { ta: "நன்கொடைகள்", en: "Donations" },
        heading: { ta: "நன்கொடைகள்", en: "Donations" },
        blocks: [
          ul(
            li(
              "இணையதளம் மூலம் வழங்கப்படும் ஒவ்வொரு நன்கொடையும் அறக்கட்டளைக்கு நீங்கள் மனமுவந்து அளிக்கும் தன்னார்வப் பங்களிப்பு. அதற்கு ஈடாக எந்தப் பொருளும் சேவையும் விற்கப்படுவதில்லை.",
              "Every donation made through this website is a voluntary contribution to the Trust. Nothing is sold or supplied in return.",
            ),
            li(
              "நீங்கள் தேர்ந்தெடுக்கும் நோக்கத்திற்கு ஏற்ப, திருக்கோவிலின் ஆன்மிக மற்றும் அறப் பணிகளுக்காக அறக்கட்டளை நன்கொடைகளைப் பயன்படுத்துகிறது.",
              "The Trust uses donations for the temple's religious and charitable work, in line with the purpose you choose.",
            ),
            li(
              "நன்கொடைகள் பொதுவாகத் திருப்பி அளிக்கப்படுவதில்லை; விதிவிலக்குகள் பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கையில் உள்ளன.",
              "Donations are generally not refundable; the exceptions are set out in the Refund & Cancellation Policy.",
            ),
          ),
          links(REFUND_LINK),
        ],
      },
      {
        id: "your-details",
        nav: { ta: "சரியான விவரங்கள்", en: "Accurate details" },
        heading: { ta: "சரியான விவரங்கள்", en: "Accurate details" },
        blocks: [
          ul(
            li(
              "உங்கள் பெயர், தொலைபேசி எண், மின்னஞ்சல், முகவரி, பான் எண் ஆகியவற்றைச் சரியாக அளிக்கவும். நீங்கள் அளிக்கும் பெயரிலேயே ரசீது வழங்கப்படும்.",
              "Give your correct name, phone number, email, address and PAN. Your receipt is issued in the name you give.",
            ),
            li(
              "தவறான விவரங்களால் ரசீது தாமதமாகலாம் அல்லது அதிலுள்ள 80G விவரங்கள் தவறாகலாம்.",
              "Wrong details can delay your receipt or make its 80G details incorrect.",
            ),
            li(
              "உங்களுடைய அல்லது பயன்படுத்த உங்களுக்கு அனுமதி உள்ள கார்டு, UPI அல்லது வங்கிக் கணக்கை மட்டுமே பயன்படுத்துங்கள்.",
              "Use only a card, UPI ID or bank account that is yours or that you are authorised to use.",
            ),
          ),
        ],
      },
      {
        id: "amounts",
        nav: { ta: "தொகையும் நாணயமும்", en: "Amounts" },
        heading: { ta: "தொகையும் நாணயமும்", en: "Amounts and currency" },
        blocks: [
          ul(
            li(
              "தொகைகள் பக்கத்தில் காட்டப்படும் நாணயத்தில் இருக்கும் — பொதுவாக இந்திய ரூபாய் (INR). பிற நாணயங்கள் வழங்கப்படும்போது மட்டுமே அவற்றைத் தேர்வு செய்யலாம்.",
              "Amounts are in the currency shown on the page, normally Indian rupees (INR). Other currencies can be chosen only when they are offered.",
            ),
            li(
              "உறுதிப்படுத்தும் பக்கத்தில் காட்டப்படும் தொகையே வசூலிக்கப்படும். அறக்கட்டளை தனியாக எந்தக் கட்டணமும் சேர்ப்பதில்லை.",
              "The amount charged is the amount shown on the review screen. The Trust adds no fee of its own.",
            ),
            li(
              "உங்கள் வங்கி அல்லது கார்டு நிறுவனம் தனது சொந்தக் கட்டணங்களையோ நாணய மாற்றுக் கட்டணங்களையோ வசூலிக்கலாம்; அவை அறக்கட்டளைக்கு வருவதில்லை.",
              "Your bank or card issuer may charge its own fees or currency-conversion charges; these do not go to the Trust.",
            ),
            li(
              "சேவைக்கான கட்டணம் திருக்கோவில் நிர்ணயித்த விலையில், இந்திய ரூபாயில் மட்டுமே.",
              "Seva payments are at the price set by the temple, in Indian rupees only.",
            ),
          ),
        ],
      },
      {
        id: "payments",
        nav: { ta: "பணம் செலுத்துதல்", en: "Payments" },
        heading: { ta: "பணம் செலுத்துதல்", en: "How payments work" },
        blocks: [
          ul(
            li(
              "பணம் செலுத்துதல் CCAvenue பணப் பரிவர்த்தனை நுழைவாயிலின் பாதுகாப்பான பக்கத்தில் நடைபெறுகிறது. UPI, டெபிட் அல்லது கிரெடிட் கார்டு, நெட் பேங்கிங், வாலெட் போன்று CCAvenue வழங்கும் எந்த முறையையும் பயன்படுத்தலாம்.",
              "Payments are processed by the CCAvenue payment gateway on its secure page. You can use any method CCAvenue offers, such as UPI, a debit or credit card, net banking or a wallet.",
            ),
            li(
              "CCAvenue உறுதி செய்த பின்பே பணம் செலுத்தப்பட்டதாகக் கருதப்படும்.",
              "A payment counts as made only once CCAvenue confirms it.",
            ),
            li(
              "உங்கள் வங்கியில் பணம் கழிக்கப்பட்டும், முடிவு “தோல்வி” அல்லது “நிலுவையில்” என்று காட்டினால், உடனே மீண்டும் செலுத்த வேண்டாம்: பணம் உறுதி செய்யப்பட்டு ரசீது அனுப்பப்படும், அல்லது உங்கள் வங்கி அதைத் தானாகத் திருப்பி அளிக்கும்.",
              "If your bank shows a debit but the result says failed or pending, please do not pay again straight away: either the payment is confirmed and your receipt is sent, or your bank returns the money automatically.",
            ),
          ),
        ],
      },
      {
        id: "receipts",
        nav: { ta: "ரசீதுகள்", en: "Receipts" },
        heading: { ta: "ரசீதுகள்", en: "Receipts" },
        blocks: [
          ul(
            li(
              "பணம் உறுதியானதும் மின்னணு ரசீது திரையில் காட்டப்படும்; நீங்கள் அளித்த தொடர்பு விவரங்களுக்கு மின்னஞ்சல், SMS அல்லது வாட்ஸ்அப் மூலமும் அனுப்பப்படும்.",
              "Once your payment is confirmed, an electronic receipt is shown on screen and sent to the contact details you gave by email, SMS or WhatsApp.",
            ),
            li(
              "ரசீதை அச்சிடலாம் அல்லது PDF ஆகச் சேமிக்கலாம். அதிலுள்ள QR குறியீட்டைக் கொண்டு ரசீது உண்மையானதா என்று யார் வேண்டுமானாலும் சரிபார்க்கலாம்.",
              "You can print the receipt or save it as a PDF. Its QR code lets anyone check that the receipt is genuine.",
            ),
            li(
              "இணையவழிப் பணத்திற்கான ரசீது கணினியால் உருவாக்கப்பட்டது; அதற்குக் கையொப்பம் தேவையில்லை.",
              "Receipts for online payments are computer-generated and need no signature.",
            ),
          ),
        ],
      },
      {
        id: "tax-exemption",
        nav: { ta: "80G வரிச்சலுகை", en: "80G" },
        heading: { ta: "80G வருமான வரிச்சலுகை", en: "80G income-tax exemption" },
        blocks: [
          p(
            `${TRUST.taxExemption.long.ta} ஒரு நன்கொடைக்கு வரிச்சலுகை கிடைப்பது, நன்கொடை வழங்கிய நாளில் அறக்கட்டளையின் பதிவும் 80G அனுமதியும் நடைமுறையில் இருப்பதையும், வருமான வரிச் சட்டத்தின் விதிகளையும் பொறுத்தது.`,
            `${TRUST.taxExemption.long.en} Whether a donation qualifies depends on the Trust's registration and 80G approval being in force on the date you give, and on the Income Tax Act.`,
          ),
          p(
            "80G சலுகை கோர விரும்பினால் உங்கள் பான் எண்ணை அளியுங்கள். அறக்கட்டளை வரி ஆலோசனை வழங்குவதில்லை; சந்தேகம் இருந்தால் உங்கள் வரி ஆலோசகரை அணுகவும்.",
            "Give your PAN if you intend to claim 80G. The Trust does not give tax advice; please ask your tax adviser if you are unsure.",
          ),
        ],
      },
      {
        id: "sevas",
        nav: { ta: "சேவை பதிவுகள்", en: "Seva bookings" },
        heading: { ta: "சேவை பதிவுகள்", en: "Seva bookings" },
        blocks: [
          ul(
            li(
              "நீங்கள் தேர்வு செய்யும் தேதி ஒரு விருப்பம் மட்டுமே; திருக்கோவில் அலுவலகம் உங்களை அழைத்துத் தேதியை உறுதி செய்யும்.",
              "The date you choose is a preference. The temple office will call you to confirm the date.",
            ),
            li(
              "சேவைகள் திருக்கோவிலின் பூஜை அட்டவணை, திருவிழாக்கள், அர்ச்சகர்களின் இருப்பு ஆகியவற்றுக்கு உட்பட்டவை.",
              "Sevas are subject to the temple's pooja schedule, festivals and the availability of the priests.",
            ),
            li(
              "குறிப்பிட்ட நேரத்திற்குள் பணம் செலுத்தப்படாத இணையவழிப் பதிவு தானாக ரத்தாகும்.",
              "An online booking that is not paid within the time shown is cancelled automatically.",
            ),
            li(
              "ரத்து செய்தலும் பணம் திருப்புதலும் பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கையின்படி நடைபெறும்.",
              "Cancellations and refunds follow the Refund & Cancellation Policy.",
            ),
          ),
        ],
      },
      {
        id: "misuse",
        nav: { ta: "தவறான பயன்பாடு", en: "Misuse" },
        heading: { ta: "தவறான பயன்பாடும் மோசடியும்", en: "Misuse and fraud" },
        blocks: [
          ul(
            li(
              "மோசடியானதாகவோ, அனுமதியற்றதாகவோ, சட்டத்திற்குப் புறம்பானதாகவோ தோன்றும் எந்தப் பணத்தையும் ஏற்க மறுக்கவோ திருப்பி அளிக்கவோ அறக்கட்டளைக்கு உரிமை உண்டு.",
              "The Trust may refuse, or refund, any payment that appears fraudulent, unauthorised or unlawful.",
            ),
            li(
              "இணையதளத்தைத் தவறாகப் பயன்படுத்துவதோ, அதன் செயல்பாட்டைக் குலைக்க முயல்வதோ, பிறரின் அனுமதியின்றி அவர் பெயரில் பணம் செலுத்துவதோ கூடாது.",
              "Do not misuse the website, try to disrupt it, or pay in someone else's name without their permission.",
            ),
            li(
              "சட்டம் கோரும் இடங்களில், இத்தகைய செயல்கள் உரிய அதிகாரிகளுக்குத் தெரிவிக்கப்படும்.",
              "Where the law requires it, such activity will be reported to the authorities.",
            ),
          ),
        ],
      },
      {
        id: "liability",
        nav: { ta: "பொறுப்பு வரம்பு", en: "Responsibility" },
        heading: { ta: "பொறுப்பு வரம்பு", en: "Limits of responsibility" },
        blocks: [
          p(
            "வங்கிகள், CCAvenue, இணைய இணைப்பு அல்லது அறக்கட்டளையின் கட்டுப்பாட்டுக்கு அப்பாற்பட்ட நிகழ்வுகளால் ஏற்படும் தாமதங்களுக்கோ தோல்விகளுக்கோ அறக்கட்டளை பொறுப்பல்ல. எனினும், பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கையின்படி உரிய பணத்தைத் திருப்பி அளிக்கும் கடமையை இது எந்த வகையிலும் குறைக்காது.",
            "The Trust is not responsible for delays or failures caused by banks, CCAvenue, internet connections or events beyond its control. This does not in any way reduce the Trust's duty to refund money due under the Refund & Cancellation Policy.",
          ),
        ],
      },
      {
        id: "governing-law",
        nav: { ta: "சட்டம்", en: "Governing law" },
        heading: { ta: "பொருந்தும் சட்டமும் நீதிமன்ற அதிகார வரம்பும்", en: "Governing law and jurisdiction" },
        blocks: [
          p(
            "இந்த விதிமுறைகள் இந்தியச் சட்டங்களுக்கு உட்பட்டவை. இவை தொடர்பான எந்தப் பிணக்கிற்கும், தமிழ்நாடு, தென்காசி மாவட்டத்தில் உள்ள நீதிமன்றங்களுக்கு மட்டுமே அதிகார வரம்பு உண்டு. எந்தக் குறையையும் முதலில் திருக்கோவில் கமிட்டியுடன் நேரடியாகப் பேசித் தீர்க்க முயல்வோம்.",
            "These terms are governed by the laws of India. The courts in Tenkasi district, Tamil Nadu, have exclusive jurisdiction over any dispute about them. We will always first try to settle any concern with you directly through the temple committee.",
          ),
        ],
      },
      {
        id: "changes",
        nav: { ta: "மாற்றங்கள்", en: "Changes" },
        heading: { ta: "விதிமுறைகளில் மாற்றங்கள்", en: "Changes to these terms" },
        blocks: [
          p(
            "இந்த விதிமுறைகளை அவ்வப்போது புதுப்பிக்கலாம். நீங்கள் பணம் செலுத்திய நாளில் நடைமுறையில் இருந்த விதிமுறைகளே அந்தப் பணத்திற்குப் பொருந்தும்.",
            "We may update these terms from time to time. A payment is governed by the terms in force on the day it was made.",
          ),
        ],
      },
    ],
    contactIntro: {
      ta: "இந்த விதிமுறைகள் பற்றிய கேள்விகளுக்கு:",
      en: "For questions about these terms:",
    },
  },

  /* ── Refund & Cancellation ───────────────────────────────────────────── */
  refunds: {
    path: POLICY_PATHS.refunds,
    title: { ta: "பணம் திருப்பி அளித்தல் & ரத்துக் கொள்கை", en: "Refund & Cancellation Policy" },
    lead: {
      ta: "நன்கொடை எப்போது திருப்பி அளிக்கப்படும், சேவை பதிவை எப்படி ரத்து செய்வது, திருப்பி அளிக்கும் பணம் எத்தனை நாட்களில் உங்களை வந்தடையும் என்பதை இங்கே அறியலாம்.",
      en: "When a donation can be refunded, how to cancel a seva booking, and how long a refund takes to reach you.",
    },
    updated: "2026-09-14",
    glance: [
      li("நன்கொடைகள் தன்னார்வமானவை; பொதுவாகத் திருப்பி அளிக்கப்படுவதில்லை.", "Donations are voluntary and generally not refundable."),
      li(
        "இருமுறை செலுத்தியது, பிழையால் தவறான தொகை, அனுமதியற்ற பரிவர்த்தனை — 7 நாட்களுக்குள் தெரிவித்தால் பணம் திருப்பி அளிக்கப்படும்.",
        "Duplicate payments, a wrong amount charged in error and unauthorised transactions are refunded if reported within 7 days.",
      ),
      li(
        "சேவை: உறுதி செய்த தேதிக்குக் குறைந்தது 48 மணி நேரம் முன்பு ரத்து செய்தால் பணம் திருப்பி அளிக்கப்படும்.",
        "Sevas: cancel at least 48 hours before the confirmed date for a refund.",
      ),
      li(
        "பணம் CCAvenue மூலம் நீங்கள் செலுத்திய அதே முறைக்கு, பொதுவாக 5–7 வேலை நாட்களில் திரும்ப வரும்.",
        "Refunds go back to your original payment method through CCAvenue, usually in 5–7 working days.",
      ),
    ],
    sections: [
      {
        id: "donations",
        nav: { ta: "நன்கொடைகள்", en: "Donations" },
        heading: { ta: "நன்கொடைகள்", en: "Donations" },
        blocks: [
          p(
            "நன்கொடைகள் அறக்கட்டளைக்கு மனமுவந்து அளிக்கப்படும் தன்னார்வப் பங்களிப்புகள்; எனவே, பொதுவாகத் திருப்பி அளிக்கப்படுவதில்லை. மனம் மாறியதற்காக நன்கொடை திருப்பி அளிக்கப்படாது. தவறான நோக்கத்தைத் தேர்வு செய்திருந்தால், எங்களைத் தொடர்பு கொள்ளுங்கள்; அதைச் சரி செய்ய உதவுவோம்.",
            "Donations are voluntary gifts to the Trust, so they are generally not refundable. A donation is not refunded because of a change of mind. If you chose the wrong purpose, contact us and we will help put it right.",
          ),
        ],
      },
      {
        id: "donation-refunds",
        nav: { ta: "திருப்பி அளிக்கும் சூழல்கள்", en: "When we refund" },
        heading: { ta: "நன்கொடை திருப்பி அளிக்கப்படும் சூழல்கள்", en: "When a donation is refunded" },
        blocks: [
          p(
            "பின்வரும் சூழல்களில், பணம் செலுத்திய 7 நாட்களுக்குள், நன்கொடை எண்ணைக் (DON- என்று தொடங்கும்) குறிப்பிட்டு எங்களுக்குத் தெரிவித்தால், பணம் திருப்பி அளிக்கப்படும்:",
            "We refund a donation in the following cases, if you tell us within 7 days of the payment and quote the Donation ID (it starts with DON-):",
          ),
          ul(
            li(
              "இருமுறை செலுத்துதல்: ஒரே நன்கொடைக்கு இரண்டு முறை பணம் வசூலிக்கப்பட்டது.",
              "Duplicate payment: you were charged twice for the same donation.",
            ),
            li(
              "தவறான தொகை: தொழில்நுட்பப் பிழையால் நீங்கள் உறுதி செய்த தொகையை விட அதிகம் வசூலிக்கப்பட்டது. கூடுதல் தொகையை — நீங்கள் கேட்டால் முழுத் தொகையையும் — திருப்பி அளிப்போம்.",
              "Wrong amount: a technical error charged you more than the amount you confirmed. We refund the excess, or the whole payment if you ask.",
            ),
            li(
              "அனுமதியற்ற பரிவர்த்தனை: உங்கள் அனுமதியின்றி உங்கள் கார்டு, UPI அல்லது வங்கிக் கணக்கைப் பயன்படுத்தி யாரோ பணம் செலுத்தினார்கள்.",
              "Unauthorised transaction: someone used your card, UPI or bank account to pay without your permission.",
            ),
          ),
          p(
            "அனுமதியற்ற பரிவர்த்தனை என்றால், உங்கள் வங்கிக்கும் உடனே தெரிவியுங்கள். திருப்பி அளிக்கப்பட்ட நன்கொடையின் ரசீதில் அது “திருப்பி அளிக்கப்பட்டது” என்று குறிக்கப்படும்; திருப்பி அளித்த தொகைக்கு 80G வரிச்சலுகை கோர இயலாது.",
            "For an unauthorised transaction, please also tell your bank straight away. When a donation is refunded, its receipt is marked as refunded, and the 80G exemption cannot be claimed for the refunded amount.",
          ),
        ],
      },
      {
        id: "failed-payments",
        nav: { ta: "தோல்வியடைந்த பணம்", en: "Failed payments" },
        heading: { ta: "தோல்வியடைந்த அல்லது நிலுவையில் உள்ள பணம்", en: "Failed or pending payments" },
        blocks: [
          p(
            "உங்கள் வங்கியில் பணம் கழிக்கப்பட்டும், இணையதளம் “தோல்வி” அல்லது “நிலுவையில்” என்று காட்டினால், தனியாகக் கோரிக்கை வைக்கத் தேவையில்லை. CCAvenue பணத்தை உறுதி செய்தால் ரசீது அனுப்பப்படும்; இல்லையெனில் உங்கள் வங்கி அதைத் தானாகத் திருப்பி அளிக்கும். 7 வேலை நாட்களுக்குள் பணம் திரும்ப வராவிட்டால், நன்கொடை எண்ணுடன் எங்களைத் தொடர்பு கொள்ளுங்கள்.",
            "If your bank shows a debit but the website says the payment failed or is pending, you do not need to ask for a refund. If CCAvenue confirms the payment, your receipt is sent; otherwise your bank returns the money automatically. If it has not come back within 7 working days, contact us with the Donation ID.",
          ),
        ],
      },
      {
        id: "seva-bookings",
        nav: { ta: "சேவை ரத்து", en: "Seva cancellation" },
        heading: { ta: "சேவை பதிவுகளை ரத்து செய்தல்", en: "Cancelling a seva booking" },
        blocks: [
          ul(
            li(
              "திருக்கோவிலால் சேவையை நடத்த இயலாவிட்டால், நீங்கள் வேறு தேதியை ஏற்காதபட்சத்தில், செலுத்திய முழுத் தொகையும் திருப்பி அளிக்கப்படும்.",
              "If the temple cannot perform the seva and you do not accept another date, the full amount you paid is refunded.",
            ),
            li(
              "அலுவலகம் உறுதி செய்த தேதிக்குக் குறைந்தது 48 மணி நேரம் முன்பு நீங்கள் ரத்து செய்தால், செலுத்திய தொகை திருப்பி அளிக்கப்படும்.",
              "If you cancel at least 48 hours before the date the office confirmed, the amount you paid is refunded.",
            ),
            li(
              "தேதி இன்னும் உறுதி செய்யப்படாத பதிவை எப்போது வேண்டுமானாலும் ரத்து செய்து முழுத் தொகையையும் திரும்பப் பெறலாம்.",
              "A booking whose date has not yet been confirmed can be cancelled at any time for a full refund.",
            ),
            li(
              "உறுதி செய்த தேதிக்கு 48 மணி நேரத்திற்குள் ரத்து செய்தால் பணம் திருப்பி அளிக்கப்படாது; ஆனால் இயன்றவரை சேவையை வேறு தேதிக்கு மாற்ற அலுவலகம் உதவும்.",
              "Cancellations made less than 48 hours before the confirmed date are not refunded, but the office will try to move the seva to another date where it can.",
            ),
            li(
              "பணம் செலுத்தாமல் விடப்பட்ட இணையவழிப் பதிவு தானாக ரத்தாகும்; அதற்கு எந்தப் பணமும் வசூலிக்கப்படுவதில்லை.",
              "An online booking that is left unpaid is cancelled automatically, and nothing is charged.",
            ),
          ),
        ],
      },
      {
        id: "how-to-ask",
        nav: { ta: "எப்படிக் கேட்பது", en: "How to ask" },
        heading: { ta: "பணம் திருப்பி அளிக்க எப்படிக் கேட்பது", en: "How to ask for a refund" },
        blocks: [
          p(
            "கீழே உள்ள தொலைபேசி எண்ணில் அழையுங்கள் அல்லது மின்னஞ்சல் அனுப்புங்கள். பின்வரும் விவரங்களைக் குறிப்பிடுங்கள்:",
            "Call or email us using the details below, and include:",
          ),
          ol(
            li("நன்கொடை எண் (DON-…) அல்லது சேவை பதிவு எண் (SEV-…)", "Your Donation ID (DON-…) or Booking ID (SEV-…)"),
            li(
              "பணம் செலுத்தும்போது அளித்த பெயரும் தொலைபேசி எண்ணும்",
              "The name and phone number used for the payment",
            ),
            li("பணம் செலுத்திய தேதியும் தொகையும்", "The date and amount of the payment"),
            li("பணத்தைத் திருப்பிக் கேட்பதற்கான காரணம்", "Why you are asking for a refund"),
          ),
          p(
            "உங்கள் பாதுகாப்பிற்காக, பணம் செலுத்தும்போது அளித்த தொலைபேசி எண் அல்லது மின்னஞ்சலுடன் உங்கள் கோரிக்கையைச் சரிபார்ப்போம். கார்டு எண், CVV, OTP, UPI PIN ஆகியவற்றை நாங்கள் ஒருபோதும் கேட்க மாட்டோம்.",
            "For your safety, we check your request against the phone number or email used for the payment. We will never ask for your card number, CVV, OTP or UPI PIN.",
          ),
        ],
      },
      {
        id: "refund-timeline",
        nav: { ta: "பணம் திரும்பும் காலம்", en: "Refund timeline" },
        heading: { ta: "பணம் எப்படி, எப்போது திரும்ப வரும்", en: "How and when refunds are paid" },
        blocks: [
          ul(
            li(
              "ஒப்புதல் பெற்ற பணம், CCAvenue மூலம் நீங்கள் செலுத்திய அதே முறைக்கே (அதே கார்டு, UPI அல்லது வங்கிக் கணக்கு) திருப்பி அனுப்பப்படும். ரொக்கமாகவோ வேறு கணக்கிற்கோ அனுப்பப்படாது.",
              "Approved refunds are sent back through CCAvenue to the method you paid with (the same card, UPI or bank account). They are not paid in cash or to a different account.",
            ),
            li(
              "அறக்கட்டளை பணத்தைத் திருப்பி அனுப்பிய பின், உங்கள் வங்கியைப் பொறுத்து, அது பொதுவாக 5–7 வேலை நாட்களில் உங்களை வந்தடையும்.",
              "Once the Trust sends a refund, it usually reaches you within 5–7 working days, depending on your bank.",
            ),
            li(
              "பணம் திருப்பி அனுப்பப்பட்டதும், உங்கள் தொடர்பு விவரங்களுக்குச் செய்தி அனுப்பப்படும்.",
              "You receive a message when the refund has been sent.",
            ),
            li(
              "செலுத்திய தொகையின் ஒரு பகுதியும் திருப்பி அளிக்கப்படலாம் (எ.கா. கூடுதலாக வசூலான தொகை மட்டும்).",
              "A refund can be for part of the payment (for example, only an amount charged in excess).",
            ),
          ),
        ],
      },
    ],
    contactIntro: {
      ta: "பணத்தைத் திருப்பிக் கேட்க அல்லது சேவை பதிவை ரத்து செய்ய:",
      en: "To ask for a refund or cancel a seva booking:",
    },
  },

  /* ── Shipping & Delivery ─────────────────────────────────────────────── */
  shipping: {
    path: POLICY_PATHS.shipping,
    title: { ta: "அனுப்புதல் & விநியோகக் கொள்கை", en: "Shipping & Delivery Policy" },
    lead: {
      ta: "அறக்கட்டளை எந்தப் பொருளையும் விற்பதோ அனுப்புவதோ இல்லை. நன்கொடை ரசீதுகள் மின்னணு முறையில் வழங்கப்படுகின்றன; சேவைகள் திருக்கோவிலில் நடைபெறுகின்றன.",
      en: "The Trust sells and ships no goods. Donation receipts are delivered electronically, and sevas are performed at the temple.",
    },
    updated: "2026-09-14",
    glance: [
      li(
        "அறக்கட்டளை இந்த இணையதளத்தின் மூலம் எந்தப் பொருளையும் விற்பதோ அனுப்புவதோ இல்லை.",
        "The Trust sells and ships no physical goods through this website.",
      ),
      li(
        "நன்கொடைக்கான மின்னணு ரசீது, பணம் உறுதியானதும் உடனே கிடைக்கும்.",
        "Your electronic donation receipt is available as soon as the payment is confirmed.",
      ),
      li(
        "சேவைகள் புதுப்பட்டி திருக்கோவிலில், உறுதி செய்யப்பட்ட தேதியில் நடைபெறும்.",
        "Sevas are performed at the temple in Pudupatti on the confirmed date.",
      ),
      li(
        "பிரசாதம் இருந்தால், திருக்கோவிலில் நேரில் பெற்றுக்கொள்ள வேண்டும்; அஞ்சலில் அனுப்பப்படாது.",
        "Any prasadam is collected at the temple and is not posted.",
      ),
    ],
    sections: [
      {
        id: "no-physical-goods",
        nav: { ta: "பொருட்கள்", en: "No goods shipped" },
        heading: { ta: "பொருட்கள் அனுப்பப்படுவதில்லை", en: "No physical goods" },
        blocks: [
          p(
            "இந்த இணையதளம் நன்கொடைகளையும் சேவைக் கட்டணங்களையும் மட்டுமே பெறுகிறது. அறக்கட்டளை எந்தப் பொருளையும் விற்பதில்லை; அஞ்சல் அல்லது கூரியர் மூலம் எதையும் அனுப்புவதில்லை. எனவே அனுப்புதல் கட்டணமோ விநியோகத் தாமதமோ இல்லை.",
            "This website accepts only donations and seva payments. The Trust sells no goods and sends nothing by post or courier, so there are no shipping charges and no delivery delays.",
          ),
        ],
      },
      {
        id: "donation-receipts",
        nav: { ta: "ரசீது வழங்குதல்", en: "Receipts" },
        heading: { ta: "நன்கொடை ரசீது வழங்குதல்", en: "How your donation is acknowledged" },
        blocks: [
          ul(
            li(
              "CCAvenue பணத்தை உறுதி செய்தவுடன், நன்கொடை எண், ரசீது எண் உள்ளிட்ட விவரங்களுடன் மின்னணு ரசீது திரையில் காட்டப்படும்.",
              "As soon as CCAvenue confirms your payment, an electronic receipt with your Donation ID and receipt number is shown on screen.",
            ),
            li(
              "அதே ரசீதுக்கான இணைப்பு, நீங்கள் அளித்த விவரங்களுக்கு ஏற்ப மின்னஞ்சல், SMS அல்லது வாட்ஸ்அப் மூலம் — பொதுவாகச் சில நிமிடங்களில் — அனுப்பப்படும்.",
              "A link to the same receipt is sent by email, SMS or WhatsApp, depending on the details you gave, usually within a few minutes.",
            ),
            li(
              "ரசீதுப் பக்கத்திலிருந்து அதை அச்சிடலாம், PDF ஆகச் சேமிக்கலாம், அல்லது மின்னஞ்சலில் மீண்டும் பெறலாம்.",
              "From the receipt page you can print it, save it as a PDF, or have it emailed to you again.",
            ),
            li(
              "செய்தி வரவில்லை என்றால், நன்கொடை எண்ணுடன் எங்களைத் தொடர்பு கொள்ளுங்கள்; ரசீதை மீண்டும் அனுப்புவோம்.",
              "If no message arrives, contact us with your Donation ID and we will send the receipt again.",
            ),
          ),
        ],
      },
      {
        id: "sevas",
        nav: { ta: "சேவைகள்", en: "Sevas" },
        heading: { ta: "சேவைகள்", en: "Sevas" },
        blocks: [
          p(
            `சேவைகள், அலுவலகம் உங்களுடன் தொலைபேசியில் உறுதி செய்யும் தேதியில், திருக்கோவிலில் (${ADDRESS.oneLine.ta}) நடைபெறுகின்றன. நீங்கள் நேரில் வந்து கலந்துகொள்ளலாம்.`,
            `Sevas are performed at the temple (${ADDRESS.oneLine.en}) on the date the temple office confirms with you by phone. You are welcome to attend in person.`,
          ),
        ],
      },
      {
        id: "prasadam",
        nav: { ta: "பிரசாதம்", en: "Prasadam" },
        heading: { ta: "பிரசாதம்", en: "Prasadam" },
        blocks: [
          p(
            "சேவையுடன் பிரசாதம் வழங்கப்பட்டால், அதைத் திருக்கோவிலில் நேரில் பெற்றுக்கொள்ள வேண்டும். பிரசாதம் அஞ்சல் அல்லது கூரியர் மூலம் அனுப்பப்படுவதில்லை.",
            "Where a seva includes prasadam, it is collected in person at the temple. Prasadam is not sent by post or courier.",
          ),
        ],
      },
      {
        id: "timelines",
        nav: { ta: "கால அளவுகள்", en: "Timelines" },
        heading: { ta: "கால அளவுகள் ஒரே பார்வையில்", en: "Timelines at a glance" },
        blocks: [
          ul(
            li("ரசீது: CCAvenue பணத்தை உறுதி செய்தவுடன் திரையில்.", "Receipt: on screen as soon as CCAvenue confirms the payment."),
            li("மின்னஞ்சல், SMS, வாட்ஸ்அப் செய்தி: பொதுவாகச் சில நிமிடங்களில்.", "Email, SMS or WhatsApp message: usually within a few minutes."),
            li("சேவை: அலுவலகம் உறுதி செய்த தேதியில்.", "Seva: on the date the office confirms."),
            li(
              "பணம் திருப்புதல்: அனுப்பிய பின் பொதுவாக 5–7 வேலை நாட்களில்.",
              "Refunds: usually within 5–7 working days after they are sent.",
            ),
          ),
          links(REFUND_LINK),
        ],
      },
    ],
    contactIntro: {
      ta: "ரசீது வரவில்லை என்றால், அல்லது சேவை பற்றிக் கேட்க:",
      en: "If your receipt has not arrived, or you have a question about a seva:",
    },
  },
};
