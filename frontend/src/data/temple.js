/**
 * src/data/temple.js — single source of truth for temple identity, address,
 * Dharma Trust registration, bank details, committee and history.
 *
 * Every Tamil string is VERBATIM from the committee's printed donation-appeal
 * booklet. English strings are translations added only because the site has
 * an EN toggle. Where the site already had an English transliteration of the
 * temple name, that is kept unchanged (see TEMPLE.name.en).
 *
 * Use with the site's i18n helper:  const { t } = useLang();  t(x.ta, x.en)
 *
 * Deity order differs by context and is preserved deliberately:
 *   • Temple name : Lingammal → Renukadevi → Chinnammal
 *   • Trust name  : Renukadevi → Lingammal → Chinnammal
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** "9443002296" → "+91 94430 02296" */
export const formatPhone = (digits) =>
  `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;

/** "9443002296" → "tel:+919443002296" */
export const telHref = (digits) => `tel:+91${digits}`;

// ── Temple identity ─────────────────────────────────────────────────────────

export const TEMPLE = {
  /** Site-wide display name. English is the site's pre-existing transliteration. */
  name: {
    ta: "அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்",
    en: "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
  },

  /** Full printed name including the clan-deity descriptor (booklet banner). */
  fullName: {
    ta: "தப்பலவார் குலதெய்வம் அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்",
    en: "Dhabbalavaar Kula Deivam — Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple",
  },

  /** "Kula Deivam" = clan deity. */
  descriptor: {
    ta: "தப்பலவார் குலதெய்வம்",
    en: "Dhabbalavaar Kula Deivam",
  },

  /** Invocation printed on the booklet's front cover. */
  invocation: {
    ta: "அருள்மிகு ஸ்ரீ லிங்கம்மாள் ஸ்ரீ ரேணுகாதேவி ஸ்ரீ சின்னம்மாள் துணை",
    en: "May Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal protect us",
  },

  /** The three deities, in temple-name order (left → centre → right in the sanctum photo). */
  deities: [
    { ta: "ஸ்ரீ லிங்கம்மாள்", en: "Sri Lingammal" },
    { ta: "ஸ்ரீ ரேணுகாதேவி", en: "Sri Renukadevi" },
    { ta: "ஸ்ரீ சின்னம்மாள்", en: "Sri Chinnammal" },
  ],

  /**
   * Two-line brand mark for the 70px navbar (space-constrained; the full name is
   * also exposed to assistive tech). Tamil follows the printed TEMPLE order;
   * English keeps the site's pre-existing transliteration.
   */
  brand: {
    line1: { ta: "தப்பலவார் ஸ்ரீ லிங்கம்மாள்", en: "Dhabbalavaar Renuka Devi" },
    line2: { ta: "ரேணுகாதேவி சின்னம்மாள் திருக்கோவில்", en: "Lingamma Sinnammal Temple" },
  },

  /** Alt text for the sanctum photograph (three deities in floral alankaram). */
  photoAlt: {
    ta: "மலர் அலங்காரத்தில் ஸ்ரீ லிங்கம்மாள் (இடது), ஸ்ரீ ரேணுகாதேவி (நடுவில்), ஸ்ரீ சின்னம்மாள் (வலது)",
    en: "Sri Lingammal (left), Sri Renukadevi (centre) and Sri Chinnammal (right) in full floral alankaram",
  },

  /**
   * Path for the sanctum photograph. The committee supplied the image in chat;
   * the file must be placed at frontend/public/images/deities-alankaram.jpg.
   * Consumers must handle a missing file gracefully (onError → hide).
   */
  photoSrc: "/images/deities-alankaram.jpg",
};

// ── Postal address ──────────────────────────────────────────────────────────

export const ADDRESS = {
  /** Street line pre-dates the booklet (not printed there); kept as existing site content. */
  street: { ta: "நடு தெரு", en: "Middle Street" },
  village: { ta: "புதுப்பட்டி", en: "Pudupatti" },
  taluk: { ta: "திருவேங்கடம் தாலுகா", en: "Thiruvengadam Taluk" },
  district: { ta: "தென்காசி மாவட்டம்", en: "Tenkasi District" },
  state: { ta: "தமிழ்நாடு", en: "Tamil Nadu" },
  pin: "627719",

  /** Exactly as printed on the booklet banner. */
  printed: {
    ta: "புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம் - 627719",
    en: "Pudupatti, Thiruvengadam Taluk, Tenkasi District – 627719",
  },

  /** Single-line form including the pre-existing street and state. */
  oneLine: {
    ta: "நடு தெரு, புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம், தமிழ்நாடு - 627719",
    en: "Middle Street, Pudupatti, Thiruvengadam Taluk, Tenkasi District, Tamil Nadu – 627719",
  },

  /** Google Maps free-text query (taluk + district disambiguate the several Pudupattis in TN). */
  mapsQuery:
    "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple, Middle Street, Pudupatti, Thiruvengadam Taluk, Tenkasi District, Tamil Nadu 627719",
};

export const MAPS_URL = `https://maps.google.com/maps?q=${encodeURIComponent(ADDRESS.mapsQuery)}`;
export const MAPS_EMBED_URL = `${MAPS_URL}&output=embed`;

// ── Dharma Trust ────────────────────────────────────────────────────────────

export const TRUST = {
  /** Trust-name deity order (Renukadevi first) — as registered. */
  name: {
    ta: "அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை",
    en: "Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust",
  },

  registrationHeading: {
    ta: "அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை பதிவு விபரம்",
    en: "Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust — Registration Details",
  },

  /**
   * The seven printed registration/bank fields, in printed order.
   * IFSC and PAN are printed with a typographic space ("TNSC 0011500",
   * "AAKTA 2241H"); both are fixed-length codes, so the space is dropped
   * for the value so it copies and transfers correctly.
   */
  registration: [
    { key: "regNo",   label: { ta: "பதிவு எண்", en: "Registration No." },              value: "9/2023 Date: 22-06-2023" },
    { key: "pan",     label: { ta: "பான் கார்டு எண்", en: "PAN Card No." },            value: "AAKTA2241H" },
    { key: "orderNo", label: { ta: "உத்தரவு எண்", en: "Order No." },                   value: "AAKTA 2241, HF 20231-23-24" },
    { key: "taxNo",   label: { ta: "வருமான வரிச்சலுகை எண்", en: "Income Tax Exemption No." }, value: "A12A IV SUB SECTION (5) OF 80'G" },
    { key: "bank",    label: { ta: "வங்கியின் பெயர்", en: "Bank Name" },
      value: { ta: "திருநெல்வேலி மத்திய கூட்டுறவு வங்கி, திருவேங்கடம் கிளை", en: "Tirunelveli Central Co-operative Bank, Thiruvengadam Branch" } },
    { key: "account", label: { ta: "வங்கி கணக்கு எண்", en: "Bank Account No." },       value: "713055315" },
    { key: "ifsc",    label: { ta: "IFSC CODE", en: "IFSC Code" },                       value: "TNSC0011500" },
  ],

  /** Convenience view of the bank fields for the donation panel. */
  bank: {
    name: { ta: "திருநெல்வேலி மத்திய கூட்டுறவு வங்கி", en: "Tirunelveli Central Co-operative Bank" },
    branch: { ta: "திருவேங்கடம் கிளை", en: "Thiruvengadam Branch" },
    accountNo: "713055315",
    ifsc: "TNSC0011500",
    regNo: "9/2023",
    regDate: "22-06-2023",
    pan: "AAKTA2241H",
  },

  taxExemption: {
    short: { ta: "80G வருமான வரிச்சலுகை", en: "80G income-tax exemption" },
    long: {
      ta: "நன்கொடையாளர்கள் வருமான வரி சலுகை பெற வருமான வரித்துறையிலிருந்து உத்தரவு பெறப்பட்டுள்ளது.",
      en: "An order has been obtained from the Income Tax Department so that donors receive income-tax exemption.",
    },
  },

  /** §5g — how the Trust came to be (verbatim). */
  narrative: {
    ta: "தற்போது அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் பெயரில் தர்ம அறக்கட்டளை நிறுவப்பட்டு இந்து மதச்சட்டப்படி பொறுப்பாளர்களை நியமனம் செய்யப்பட்டுள்ளது. அறக்கட்டளை பெயரில் பான் கார்டு பெறப்பட்டு திருநெல்வேலி மத்திய கூட்டுறவு வங்கி திருவேங்கடம் கிளையில் வங்கி கணக்கும் துவக்கப்பட்டுள்ளது. நன்கொடையாளர்கள் வருமான வரி சலுகை பெற வருமான வரித்துறையிலிருந்து உத்தரவு பெறப்பட்டுள்ளது. இவைகள் விபரங்கள் கீழே கொடுக்கப்பட்டுள்ளது.",
    en: "A Dharma Trust has now been established in the name of Arulmigu Sri Lingammal, Sri Renukadevi and Sri Chinnammal, with office-bearers appointed in accordance with Hindu religious law. A PAN card has been obtained in the Trust's name and a bank account opened at the Tirunelveli Central Co-operative Bank, Thiruvengadam Branch. An order has been obtained from the Income Tax Department so that donors receive income-tax exemption. The details are given below.",
  },
};

// ── Temple committee ────────────────────────────────────────────────────────

export const COMMITTEE = {
  heading: { ta: "திருக்கோவில் கமிட்டியார்", en: "Temple Committee" },
  invite: { ta: "அன்புடன் அழைக்கும் திருக்கோவில் கமிட்டியார்", en: "With warm regards, The Temple Committee" },
  signoff: {
    ta: "அருள்மிகு ஸ்ரீ லிங்கம்மாள் ஸ்ரீ ரேணுகாதேவி ஸ்ரீ சின்னம்மாள் திருக்கோவில், புதுப்பட்டி.",
    en: "Arulmigu Sri Lingammal Sri Renukadevi Sri Chinnammal Temple, Pudupatti.",
  },
  /** In printed order. `phone` is the bare 10-digit mobile number. */
  members: [
    { name: { ta: "S. கெங்கையா",     en: "S. Gengaiah"  }, role: { ta: "தலைவர்",          en: "President"       }, phone: "9443002296" },
    { name: { ta: "S. பொன்ராஜ்",     en: "S. Ponraj"    }, role: { ta: "உபதலைவர்",        en: "Vice President"  }, phone: "9443126612" },
    { name: { ta: "G. குமார்",       en: "G. Kumar"     }, role: { ta: "செயலாளர்",        en: "Secretary"       }, phone: "7373016302" },
    { name: { ta: "A. குருசாமி",     en: "A. Gurusamy"  }, role: { ta: "இணைச்செயலாளர்",   en: "Joint Secretary" }, phone: "8220552427" },
    { name: { ta: "K. இராஜேந்திரன்", en: "K. Rajendran" }, role: { ta: "பொருளாளர் 1",     en: "Treasurer 1"     }, phone: "9965040693" },
    { name: { ta: "L. சிவக்குமார்",  en: "L. Sivakumar" }, role: { ta: "பொருளாளர் 2",     en: "Treasurer 2"     }, phone: "9488468206" },
  ],
};

/** The booklet names no single "temple office" line; the President heads the printed list. */
export const PRIMARY_CONTACT = COMMITTEE.members[0];
/** Secretary — customary point of contact for correspondence and bookings. */
export const SECONDARY_CONTACT = COMMITTEE.members[2];

// ── History (appeal letter, §5a–5h) ─────────────────────────────────────────

export const HISTORY = {
  salutation: { ta: "அன்புடையீர்,", en: "Dear devotees," },

  /** One-card condensation of §5b–5d for teasers (facts only; nothing added). */
  summary: {
    ta: "பல நூற்றாண்டுகளுக்கு முன்பு தப்பலார் குலப் பெரியோர்களால் புதுப்பட்டியில் நிறுவப்பட்ட நமது குலதெய்வக் கோவில். 1990-ல் மூன்று தெய்வங்களுக்கும் சிலை பிரதிஷ்டை; 10-06-2012-ல் மஹா கும்பாபிஷேகம். அன்று முதல் தினமும் பூஜை.",
    en: "Our clan-deity temple, established at Pudupatti many centuries ago by the elders of the Dhabbalaar community. Idols of the three deities were consecrated in 1990 and the Maha Kumbabhishekam performed on 10-06-2012, with daily pooja ever since.",
  },

  /** Narrative paragraphs in printed order. */
  paragraphs: [
    {
      key: "origins",
      ta: "தப்பலார் குலமக்களுக்கு பல நூற்றாண்டுகளுக்கு முன்பு நமது குல தெய்வங்களான அருள்மிகு ஸ்ரீ லிங்கம்மாள் ரேணுகாதேவி சின்னம்மாள் திருக்கோவில் புதுப்பட்டியில் பெரியோர்களால் நிறுவப்பட்டு நமது குலமக்கள் வழிபட்டு வருகின்றோம். இந்த கோவிலில் நமது குலதெய்வங்கள் கொண்டு வந்த நார்பெட்டியும் அதற்குள் அவர்கள் கொண்டு வந்த பட்டுச்சேலை, வளையல் முதலியன இருந்தது. இந்த பெட்டியை வைத்து தான் நாம் வணங்கி வந்தோம்.",
      en: "Many centuries ago, this temple to our clan deities — Arulmigu Sri Lingammal, Renukadevi and Chinnammal — was established at Pudupatti by the elders of the Dhabbalaar community, and our people have worshipped here ever since. The temple held the fibre box (naar-petti) brought by our clan deities, containing the silk saree, bangles and other articles they had carried with them. It was before this sacred box that we offered our worship.",
    },
    {
      key: "idols",
      ta: "1990-ம் ஆண்டு மூன்று தெய்வங்களுக்கு சிலை உருவம் வடிவமைத்து பிரதிஷ்டை செய்தனர்.",
      en: "In 1990, idols were sculpted for the three deities and consecrated.",
    },
    {
      key: "kumbabhishekam",
      ta: "2011-ம் ஆண்டு நமது இனப்பெரியவர்கள் மனமுவந்து நன்கொடை வழங்கினார்கள். இவர்களது நன்கொடையால் கோவில் கோபுரம் கட்டி, 1187-ம் ஆண்டு நந்தன வருடம் வைகாசி மாதம் 28-ம் தேதி (10-06-2012) ஞாயிற்றுக்கிழமை பிரதிஷ்டை செய்து ஜீர்ணோத்தாரண அஷ்டபந்தன மஹா கும்பாபிஷேகம் சிறப்பாக செய்யப்பட்டது. இதிலிருந்து தினமும் பூஜை முறைகள் நடைபெற்று வருகின்றது.",
      en: "In 2011, the elders of our community came forward with generous donations. With these, the temple gopuram was built, and on Sunday, 28th Vaikasi of the Nandana year 1187 (10-06-2012), the Jeernoddharana Ashtabandhana Maha Kumbabhishekam was performed with great grandeur. Daily pooja rituals have continued ever since.",
    },
    {
      key: "shivaratri",
      ta: "ஒவ்வொரு மஹா சிவராத்திரி அன்று நமது குல மக்கள் வந்து தரிசனம் செய்து வருகின்றார்கள். அன்று அன்னதானமும் நடைபெற்று வருகின்றது.",
      en: "Every Maha Shivaratri, our clan members gather for darshan, and annadanam is offered on that day.",
    },
    {
      key: "pournami",
      ta: "தற்போது ஒவ்வொரு மாதம் பௌர்ணமி அன்றும் பூஜையும் அன்னதானமும் சிறப்பாக நடைபெற்று வருகிறது. இந்த பூஜையில் நமது குலமக்கள் அனைவரும் கலந்து கொண்டு நமது குலதெய்வங்களின் அருளாசியும் பெற்று வருகின்றார்கள்.",
      en: "Today, special pooja and annadanam are held every month on Pournami (full moon). All our clan members take part and receive the blessings of our clan deities.",
    },
  ],

  /** Milestones for a timeline view. `date` is ISO where a Gregorian date is printed. */
  timeline: [
    {
      key: "origins",
      year: { ta: "பல நூற்றாண்டுகளுக்கு முன்பு", en: "Centuries ago" },
      title: { ta: "குலதெய்வக் கோவில் நிறுவப்பட்டது", en: "The clan-deity temple is founded" },
      desc: {
        ta: "தப்பலார் குலப் பெரியோர்களால் புதுப்பட்டியில் நிறுவப்பட்டது. குலதெய்வங்கள் கொண்டு வந்த நார்பெட்டியை — அதனுள் பட்டுச்சேலை, வளையல் — வைத்து வணங்கி வந்தோம்.",
        en: "Established at Pudupatti by the elders of the Dhabbalaar community. Worship was offered before the naar-petti, the fibre box the deities brought, holding a silk saree and bangles.",
      },
    },
    {
      key: "idols",
      year: { ta: "1990", en: "1990" },
      title: { ta: "மூன்று தெய்வங்களுக்கு சிலை பிரதிஷ்டை", en: "Idols of the three deities consecrated" },
      desc: {
        ta: "மூன்று தெய்வங்களுக்கு சிலை உருவம் வடிவமைத்து பிரதிஷ்டை செய்தனர்.",
        en: "Idols were sculpted for the three deities and consecrated.",
      },
    },
    {
      key: "donations2011",
      year: { ta: "2011", en: "2011" },
      title: { ta: "இனப்பெரியவர்களின் நன்கொடை — கோபுரம்", en: "Community donations build the gopuram" },
      desc: {
        ta: "நமது இனப்பெரியவர்கள் மனமுவந்து நன்கொடை வழங்கினார்கள். இவர்களது நன்கொடையால் கோவில் கோபுரம் கட்டப்பட்டது.",
        en: "The elders of our community came forward with generous donations, with which the temple gopuram was built.",
      },
    },
    {
      key: "kumbabhishekam2012",
      year: { ta: "10-06-2012", en: "10-06-2012" },
      date: "2012-06-10",
      tamilDate: { ta: "1187 நந்தன வருடம் வைகாசி 28, ஞாயிறு", en: "28 Vaikasi, Nandana year 1187, Sunday" },
      title: { ta: "ஜீர்ணோத்தாரண அஷ்டபந்தன மஹா கும்பாபிஷேகம்", en: "Jeernoddharana Ashtabandhana Maha Kumbabhishekam" },
      desc: {
        ta: "பிரதிஷ்டை செய்து மஹா கும்பாபிஷேகம் சிறப்பாக செய்யப்பட்டது. இதிலிருந்து தினமும் பூஜை முறைகள் நடைபெற்று வருகின்றது.",
        en: "The consecration and Maha Kumbabhishekam were performed with great grandeur. Daily pooja rituals have continued ever since.",
      },
    },
    {
      key: "trust2023",
      year: { ta: "22-06-2023", en: "22-06-2023" },
      date: "2023-06-22",
      title: { ta: "தர்ம அறக்கட்டளை பதிவு", en: "Dharma Trust registered" },
      desc: {
        ta: "தர்ம அறக்கட்டளை நிறுவப்பட்டு (பதிவு எண் 9/2023) இந்து மதச்சட்டப்படி பொறுப்பாளர்கள் நியமிக்கப்பட்டனர்; பான் கார்டு, வங்கிக் கணக்கு, 80G வரிச்சலுகை உத்தரவு பெறப்பட்டது.",
        en: "The Dharma Trust was established (Reg. No. 9/2023) with office-bearers appointed under Hindu religious law; PAN, a bank account and the 80G income-tax exemption order were obtained.",
      },
    },
    {
      key: "landDonation",
      year: { ta: "தற்போது", en: "Now" },
      status: "inProgress",
      title: { ta: "அன்னதான கூடம் & கழிப்பறைகள் கட்டப்படுகின்றன", en: "Annadanam hall and toilets under construction" },
      desc: {
        ta: "திரு. த.கா. சுப்பாராம் குடும்பத்தார் நன்கொடையாக வழங்கிய இடத்தில் அன்னதான கூடமும் கழிப்பறைகளும் கட்டப்படுகின்றன. தங்கும் ஓய்வறைகள் சகல வசதியுடன் அமைக்கவும் முடிவெடுக்கப்பட்டுள்ளது.",
        en: "On land donated by the family of Thiru T.K. Subbaram, an annadanam hall and toilets are being built. Rest rooms with every facility are also planned.",
      },
    },
    {
      key: "kumbabhishekamDue",
      year: { ta: "வரவிருக்கும்", en: "Upcoming" },
      status: "planned",
      title: { ta: "மஹா கும்பாபிஷேகம் — 12 ஆண்டுகள் நிறைவு", en: "Maha Kumbabhishekam — 12 years on" },
      desc: {
        ta: "2012-ல் கும்பாபிஷேகம் செய்து 12 வருடங்கள் முடிவடைந்துள்ளது. கும்பாபிஷேகம் செய்யவும் கட்டிடங்கள் கட்டவும் நன்கொடை வேண்டப்படுகிறது.",
        en: "Twelve years have passed since the Kumbabhishekam of 2012. Donations are sought for the next Kumbabhishekam and for the new buildings.",
      },
    },
  ],
};

/** §5h — land donation (verbatim). */
export const LAND_DONATION = {
  heading: { ta: "அன்னதான கூடம் & இட நன்கொடை", en: "Annadanam Hall & Land Donation" },
  ta: "நமது இனபந்துக்கள் கோவிலுக்கு வந்து சுவாமி தரிசனம் செய்பவர்களுக்கு போதிய வசதி இல்லை. அன்னதானம் வழங்கவும் போதிய வசதியும் இல்லை. இவை அனைத்தும் நிவர்த்தி செய்ய நம் இன பெரியவர்கள் முடிவு செய்தார்கள். இந்த முடிவின்படி முதலில் அன்னதான கூடம் கட்ட புதுப்பட்டியை பூர்வீகமாக கொண்டு தற்போது இராஜபாளையத்தில் வசித்து வரும் திரு. த.கா. சுப்பாராம் (காவல்துறை உதவி ஆய்வாளர், ஓய்வு) அவர்கள் குடும்பத்தார்கள் கோவிலுக்கு இடவசதி கொடுக்க முன் வந்து இடத்தை நன்கொடையாக திரு. த.கா.சுப்பாராம் அவர்கள் மனைவி திருமதி. இராமலட்சுமி அவர்களும் இவர்களது மகன் திரு. சீனிவாசன் அவர்களும் நமது தர்ம அறக்கட்டளை பெயரில் பத்திரம் பதிவு செய்து வழங்கியுள்ளார்கள். இந்த இடத்தில் தற்போது அன்னதான கூடமும், கழிப்பறைகளும் கட்டிக் கொண்டு உள்ளோம். இதுபோன்று தங்கும் ஓய்வறைகள் சகல வசதியும் அமைக்கவும் முடிவெடுக்கப்பட்டுள்ளது.",
  en: "Devotees of our community who visit the temple for darshan lack adequate facilities, and there is no proper provision for serving annadanam. Our community elders resolved to address all of this. As a first step towards building an annadanam hall, the family of Thiru T.K. Subbaram (Sub-Inspector of Police, Retd.) — a native of Pudupatti now residing in Rajapalayam — came forward to provide land for the temple. His wife Thirumathi Ramalakshmi and their son Thiru Srinivasan have registered the deed and donated the land in the name of our Dharma Trust. On this land we are now constructing an annadanam hall and toilets. It has also been resolved to build rest rooms with every facility.",
  donors: {
    family: { ta: "திரு. த.கா. சுப்பாராம் குடும்பத்தார்", en: "Family of Thiru T.K. Subbaram" },
    detail: { ta: "காவல்துறை உதவி ஆய்வாளர் (ஓய்வு), இராஜபாளையம்", en: "Sub-Inspector of Police (Retd.), Rajapalayam" },
    names: { ta: "திருமதி. இராமலட்சுமி & திரு. சீனிவாசன்", en: "Thirumathi Ramalakshmi & Thiru Srinivasan" },
  },
};

/** §5i — Kumbabhishekam appeal (verbatim; the booklet says "this year"). */
export const KUMBABHISHEKAM_APPEAL = {
  heading: { ta: "கும்பாபிஷேக வேண்டுகோள்", en: "Kumbabhishekam Appeal" },
  ta: "மேலும் 2012-ல் கும்பாபிஷேகம் செய்து 12 வருடங்கள் முடிவடைந்துள்ளது. இவ்வருடம் கும்பாபிஷேகம் செய்ய வேண்டியுள்ளது. கும்பாபிஷேகம் செய்யவும் கட்டிடங்கள் கட்டுவதற்கும் நம் இனபெரியவர்கள் ஒத்துழைப்பு கொடுத்து தாராளமாக நன்கொடை வழங்குமாறு அன்புடன் கேட்டுக்கொள்கிறோம்.",
  en: "Twelve years have now passed since the Kumbabhishekam of 2012, and it is due to be performed again this year. We warmly request the elders of our community to lend their support and donate generously, both for the Kumbabhishekam and for the construction of these buildings.",
};

/** §5j — donation methods and receipt policy (verbatim). */
export const DONATION_NOTE = {
  heading: { ta: "குறிப்பு", en: "Note" },
  methods: {
    ta: "நன்கொடை வழங்குபவர்கள் வங்கிக் கணக்கிலும் அல்லது காசோலையாகவும் அறக்கட்டளை பெயரில் வழங்கலாம்.",
    en: "Donations may be made to the Trust's bank account or by cheque in the Trust's name.",
  },
  receipt: {
    ta: "இவை அனைத்தும் வழங்கும் போது நிர்வாகத்திற்கு தங்களது முகவரி தெளிவாக வழங்கினால் மட்டுமே ரசீது அனுப்பி வைக்கப்படும். நன்கொடை பெற நேரடியாக வருபவர்களிடம் ரசீது பெற்றுக் கொள்ளும்படி அன்புடன் கேட்டுக்கொள்கிறோம். ரசீது வாங்காமல் கொடுக்கும் பணத்திற்கு அறக்கட்டளை பொறுப்பல்ல.",
    en: "A receipt will be sent only if your full address is clearly provided to the administration at the time of donating. Those donating in person are kindly requested to collect a receipt. The Trust is not responsible for any money given without a receipt.",
  },
};

/** Recurring observances named in the booklet (for cards, chat, event fallbacks). */
export const OBSERVANCES = {
  pournami: {
    label: { ta: "பௌர்ணமி பூஜை & அன்னதானம்", en: "Pournami Pooja & Annadanam" },
    when: { ta: "மாதந்தோறும்", en: "Every month" },
    desc: HISTORY.paragraphs.find((p) => p.key === "pournami"),
  },
  shivaratri: {
    label: { ta: "மஹா சிவராத்திரி — தரிசனம் & அன்னதானம்", en: "Maha Shivaratri — Darshan & Annadanam" },
    when: { ta: "ஆண்டுதோறும்", en: "Annual" },
    desc: HISTORY.paragraphs.find((p) => p.key === "shivaratri"),
  },
};

/** Facilities status (replaces an earlier unsupported "wheelchair access" claim). */
export const FACILITIES = {
  label: { ta: "வசதிகள்", en: "Facilities" },
  status: {
    ta: "அன்னதான கூடமும் கழிப்பறைகளும் கட்டப்பட்டு வருகின்றன; தங்கும் ஓய்வறைகள் திட்டமிடப்பட்டுள்ளன.",
    en: "Annadanam hall and toilets under construction; rest rooms planned.",
  },
};
