<?php
// backend/api/chat.php — POST only (AI / rule-based chatbot)

require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

$body    = getJsonBody();
$message = sanitizeText($body['message'] ?? '', 500);
$history = is_array($body['history'] ?? null) ? array_slice($body['history'], -8) : [];

if ($message === '') {
    sendError('Message is required');
}

// ── Temple system prompt ───────────────────────────────────────────────
// Facts are transcribed from the committee's printed donation-appeal booklet
// (mirrored in frontend/src/data/temple.js). Daily timings and the seva list
// were not in the booklet and are carried over unchanged. The heredoc
// interpolates variables, so keep literal dollar signs out of it.
$systemPrompt = <<<PROMPT
You are a helpful, devotional assistant for Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple, Pudupatti (அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில், புதுப்பட்டி) — the Dhabbalavaar Kula Deivam (clan-deity) temple, referred to on this website as "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple".
Answer ONLY questions about this temple. Information you know:
- Deities: Sri Lingammal, Sri Renukadevi, Sri Chinnammal. Deity order in the temple name is Lingammal → Renukadevi → Chinnammal; in the Trust name it is Renukadevi → Lingammal → Chinnammal — preserve each exactly.
- Daily timings: Morning 6:00 AM – 12:30 PM | Evening 4:00 PM – 9:00 PM
- Sevas: Abhishekam, Archana, Homam, Neivedyam, Alangaram, Thiruvanandal
- Events: every month on Pournami (full moon) — special pooja and annadanam in which all clan members take part | every Maha Shivaratri — clan members gather for darshan and annadanam is offered | Kumbabhishekam anniversary — Vaikasi 28 (10 June). Other festival dates (Thai Poosam, Panguni Uthiram, Aadi Pooram, Karthigai Deepam) are NOT confirmed — if asked, say they are to be confirmed by the temple committee.
- History: founded many centuries ago at Pudupatti by the elders of the Dhabbalaar clan; worship was offered before the naar-petti (the fibre box the clan deities brought, holding a silk saree and bangles). 1990 — idols of the three deities sculpted and consecrated. 2011 — community donations built the gopuram. Sunday 10-06-2012 (28 Vaikasi, Nandana year 1187) — Jeernoddharana Ashtabandhana Maha Kumbabhishekam performed; daily pooja has continued ever since. 22-06-2023 — Dharma Trust registered. Land was donated by the family of Thiru T.K. Subbaram (Assistant Sub-Inspector of Police, Retd., native of Pudupatti, now in Rajapalayam) — his wife Thirumathi Ramalakshmi and son Thiru Srinivasan registered the deed in the Trust's name; on that land an annadanam hall and toilets are under construction and rest rooms are planned. The next Maha Kumbabhishekam is due: say "12 years since 10-06-2012", NOT "this year". Donations are sought for the Kumbabhishekam and the buildings.
- Dharma Trust: Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust (அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை). Registration No. 9/2023 dated 22-06-2023 | PAN AAKTA2241H | Order No. AAKTA 2241, HF 20231-23-24 | Income Tax Exemption No. A12A IV SUB SECTION (5) OF 80'G — donors receive 80G income-tax exemption.
- Donations: by bank transfer or cheque in the Trust's name ONLY. Bank: Tirunelveli Central Co-operative Bank, Thiruvengadam Branch | A/C 713055315 | IFSC TNSC0011500. Receipt policy: a receipt is sent only if the donor's full address is clearly given to the administration at the time of donating; donors giving in person must collect a receipt; the Trust is not responsible for money given without a receipt. There is NO UPI ID — never invent or suggest one.
- Address: Pudupatti, Thiruvengadam Taluk, Tenkasi District – 627719, Tamil Nadu (புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம் - 627719).
- Temple committee (name, role, phone): S. Gengaiah (S. கெங்கையா), President, +91 94430 02296 | S. Ponraj (S. பொன்ராஜ்), Vice President, +91 94431 26612 | G. Kumar (G. குமார்), Secretary, +91 73730 16302 | A. Gurusamy (A. குருசாமி), Joint Secretary, +91 82205 52427 | K. Rajendran (K. இராஜேந்திரன்), Treasurer 1, +91 99650 40693 | L. Sivakumar (L. சிவக்குமார்), Treasurer 2, +91 94884 68206.
- Email: No email address has been supplied — do not invent one; direct devotees to the Contact page form.
Keep replies concise (2-4 lines). If the user writes in Tamil, reply in Tamil. If in English, reply in English.
Do not answer anything unrelated to this temple. Never state a fact that is not listed above.
PROMPT;

// ── Try Gemini 1.5 Flash if API key is configured ─────────────────────
$apiKey = getenv('GEMINI_API_KEY') ?: '';

if ($apiKey !== '') {
    $contents = [];

    foreach ($history as $h) {
        $role       = ($h['role'] ?? 'user') === 'assistant' ? 'model' : 'user';
        $contents[] = ['role' => $role, 'parts' => [['text' => sanitizeText((string)($h['text'] ?? ''), 500)]]];
    }
    $contents[] = ['role' => 'user', 'parts' => [['text' => $message]]];

    $payload = [
        'system_instruction' => ['parts' => [['text' => $systemPrompt]]],
        'contents'           => $contents,
        'generationConfig'   => [
            'maxOutputTokens' => 300,
            'temperature'     => 0.6,
        ],
    ];

    $url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' . urlencode($apiKey);
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);

    $response = curl_exec($ch);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if (!$curlErr && $response) {
        $data = json_decode($response, true);
        $text = $data['candidates'][0]['content']['parts'][0]['text'] ?? null;
        if ($text !== null && $text !== '') {
            sendJson(['reply' => trim($text)]);
        }
    }
    // If Gemini fails, fall through to rule-based
}

// ── Rule-based fallback ────────────────────────────────────────────────
// First match wins. Specific rules (trust, committee, history, events) sit
// ahead of the broad timing / seva / donation regexes so that, e.g.,
// "kumbabhishekam" (contains "abhishekam") and "pournami pooja" are not
// swallowed by the seva rule, and "annadanam" (contains "தானம்") is not
// swallowed by the donation rule.
$msg = mb_strtolower($message, 'UTF-8');

$rules = [
    '/வணக்கம்|நமஸ்காரம்|hello|^hi\b|namask/u'
        => "வணக்கம்! 🙏 தப்பலவார் குலதெய்வம் அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில், புதுப்பட்டி — தங்களை அன்புடன் வரவேற்கிறோம்.\n"
         . "Namaskar! Welcome to Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple, Pudupatti — the Dhabbalavaar Kula Deivam temple. How can I help you today?",

    '/அறக்கட்டளை|trust|80\s?g|\bpan\b|(?<![\p{L}\p{M}])பான்|வரிச்சலுகை|tax(?!i)|ரசீது|receipt|ifsc/u'
        => "அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை பதிவு விபரம் 🛕\n"
         . "📋 பதிவு எண்: 9/2023 (22-06-2023)\n"
         . "🆔 பான் கார்டு எண்: AAKTA2241H\n"
         . "✅ 80G வருமான வரிச்சலுகை: நன்கொடையாளர்கள் வருமான வரி சலுகை பெற வருமான வரித்துறையிலிருந்து உத்தரவு பெறப்பட்டுள்ளது.\n"
         . "🏦 வங்கியின் பெயர்: திருநெல்வேலி மத்திய கூட்டுறவு வங்கி, திருவேங்கடம் கிளை\n"
         . "🔢 வங்கி கணக்கு எண்: 713055315 | IFSC CODE: TNSC0011500\n"
         . "🧾 நிர்வாகத்திற்கு தங்களது முகவரி தெளிவாக வழங்கினால் மட்டுமே ரசீது அனுப்பி வைக்கப்படும். நன்கொடை பெற நேரடியாக வருபவர்களிடம் ரசீது பெற்றுக் கொள்ளும்படி அன்புடன் கேட்டுக்கொள்கிறோம். ரசீது வாங்காமல் கொடுக்கும் பணத்திற்கு அறக்கட்டளை பொறுப்பல்ல.\n"
         . "\n"
         . "Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust — Registration Details\n"
         . "📋 Registration No.: 9/2023 (Date: 22-06-2023)\n"
         . "🆔 PAN: AAKTA2241H\n"
         . "✅ 80G income-tax exemption: an order has been obtained from the Income Tax Department so that donors receive income-tax exemption.\n"
         . "🏦 Bank: Tirunelveli Central Co-operative Bank, Thiruvengadam Branch\n"
         . "🔢 A/C No.: 713055315 | IFSC: TNSC0011500\n"
         . "🧾 A receipt is sent only if your full address is clearly provided to the administration when donating. Those donating in person are kindly requested to collect a receipt. The Trust is not responsible for any money given without a receipt.",

    '/கமிட்டி|committee|தலைவர்|செயலாளர்|பொருளாளர்|president|secretary|treasurer|நிர்வாக|office.?bearer/u'
        => "திருக்கோவில் கமிட்டியார் 🙏\n"
         . "👤 தலைவர் – S. கெங்கையா – +91 94430 02296\n"
         . "👤 உபதலைவர் – S. பொன்ராஜ் – +91 94431 26612\n"
         . "👤 செயலாளர் – G. குமார் – +91 73730 16302\n"
         . "👤 இணைச்செயலாளர் – A. குருசாமி – +91 82205 52427\n"
         . "👤 பொருளாளர் 1 – K. இராஜேந்திரன் – +91 99650 40693\n"
         . "👤 பொருளாளர் 2 – L. சிவக்குமார் – +91 94884 68206\n"
         . "\n"
         . "Temple Committee\n"
         . "👤 President – S. Gengaiah – +91 94430 02296\n"
         . "👤 Vice President – S. Ponraj – +91 94431 26612\n"
         . "👤 Secretary – G. Kumar – +91 73730 16302\n"
         . "👤 Joint Secretary – A. Gurusamy – +91 82205 52427\n"
         . "👤 Treasurer 1 – K. Rajendran – +91 99650 40693\n"
         . "👤 Treasurer 2 – L. Sivakumar – +91 94884 68206",

    '/வரலாறு|history|நார்பெட்டி|கோபுர|gopuram|\b1990\b|\b2012\b|சிலை|idol|நிலம்|இட\s?நன்கொடை|land donat|donated (the )?land|சுப்பாராம்|subbaram|அன்னதான\s?கூடம்|annadanam hall|கும்பாபிஷேக|kumbabhishek/u'
        => "திருக்கோவில் வரலாறு 🛕\n"
         . "• பல நூற்றாண்டுகளுக்கு முன்பு தப்பலார் குலப் பெரியோர்களால் புதுப்பட்டியில் நிறுவப்பட்டது. குலதெய்வங்கள் கொண்டு வந்த நார்பெட்டியை — அதனுள் பட்டுச்சேலை, வளையல் — வைத்து வணங்கி வந்தோம்.\n"
         . "• 1990: மூன்று தெய்வங்களுக்கு சிலை உருவம் வடிவமைத்து பிரதிஷ்டை செய்தனர்.\n"
         . "• 2011: இனப்பெரியவர்களின் நன்கொடையால் கோவில் கோபுரம் கட்டப்பட்டது. 1187 நந்தன வருடம் வைகாசி 28, ஞாயிறு (10-06-2012) ஜீர்ணோத்தாரண அஷ்டபந்தன மஹா கும்பாபிஷேகம் சிறப்பாக செய்யப்பட்டது. இதிலிருந்து தினமும் பூஜை முறைகள் நடைபெற்று வருகின்றது.\n"
         . "• 22-06-2023: தர்ம அறக்கட்டளை பதிவு (பதிவு எண் 9/2023); பான் கார்டு, வங்கிக் கணக்கு, 80G வரிச்சலுகை உத்தரவு பெறப்பட்டது.\n"
         . "• திரு. த.கா. சுப்பாராம் (காவல்துறை உதவி ஆய்வாளர், ஓய்வு, இராஜபாளையம்) குடும்பத்தார் — திருமதி. இராமலட்சுமி & திரு. சீனிவாசன் — அறக்கட்டளை பெயரில் நன்கொடையாக வழங்கிய இடத்தில் அன்னதான கூடமும் கழிப்பறைகளும் கட்டப்படுகின்றன; தங்கும் ஓய்வறைகள் திட்டமிடப்பட்டுள்ளன.\n"
         . "• 2012-ல் கும்பாபிஷேகம் செய்து 12 வருடங்கள் முடிவடைந்துள்ளது. அடுத்த மஹா கும்பாபிஷேகத்திற்கும் கட்டிடங்களுக்கும் நன்கொடை வேண்டப்படுகிறது.\n"
         . "\n"
         . "Temple History\n"
         . "• Founded many centuries ago at Pudupatti by the elders of the Dhabbalaar clan. Worship was offered before the naar-petti — the fibre box the clan deities brought, holding a silk saree and bangles.\n"
         . "• 1990: idols were sculpted for the three deities and consecrated.\n"
         . "• 2011: community donations built the temple gopuram. On Sunday 10-06-2012 (28 Vaikasi, Nandana year 1187) the Jeernoddharana Ashtabandhana Maha Kumbabhishekam was performed. Daily pooja has continued ever since.\n"
         . "• 22-06-2023: Dharma Trust registered (Reg. No. 9/2023); PAN, bank account and 80G exemption obtained.\n"
         . "• On land donated in the Trust's name by the family of Thiru T.K. Subbaram (Asst. Sub-Inspector of Police, Retd., Rajapalayam) — Thirumathi Ramalakshmi & Thiru Srinivasan — an annadanam hall and toilets are under construction; rest rooms are planned.\n"
         . "• 12 years have passed since the Kumbabhishekam of 10-06-2012. Donations are sought for the next Maha Kumbabhishekam and for the buildings.",

    '/திருவிழா|நிகழ்|festival|event|poosam|shivaratri|panguni|karthigai|aadi|பௌர்ணமி|pournami|full moon|அன்னதான|annadanam|சிவராத்திரி|anniversary|vaikasi|வைகாசி/u'
        => "நிகழ்வுகள் 🎉\n"
         . "🌕 மாதந்தோறும் — பௌர்ணமி பூஜை & அன்னதானம்: ஒவ்வொரு மாதம் பௌர்ணமி அன்றும் பூஜையும் அன்னதானமும் சிறப்பாக நடைபெற்று வருகிறது.\n"
         . "🕉️ ஆண்டுதோறும் — மஹா சிவராத்திரி: குல மக்கள் வந்து தரிசனம் செய்கின்றனர்; அன்று அன்னதானமும் நடைபெறுகிறது.\n"
         . "🛕 கும்பாபிஷேக நினைவு நாள்: வைகாசி 28 (10 ஜூன்). 2012-ல் கும்பாபிஷேகம் செய்து 12 வருடங்கள் முடிவடைந்துள்ளது — அடுத்த மஹா கும்பாபிஷேகத்திற்கு நன்கொடை வேண்டப்படுகிறது.\n"
         . "மற்ற திருவிழா தேதிகள்: உறுதி செய்யப்பட வேண்டும் — கமிட்டியாரை தொடர்பு கொள்ளவும்.\n"
         . "\n"
         . "Events\n"
         . "🌕 Every month — Pournami Pooja & Annadanam: special pooja and annadanam are held every full-moon day.\n"
         . "🕉️ Annual — Maha Shivaratri: clan members gather for darshan, and annadanam is offered.\n"
         . "🛕 Kumbabhishekam anniversary: Vaikasi 28 (10 June). 12 years have passed since the Kumbabhishekam of 2012 — donations are sought for the next Maha Kumbabhishekam.\n"
         . "Other festival dates: to be confirmed — please contact the Temple Committee.",

    '/நேரம்|திற(?!்)|மூடு|time|timing|hour|open|close/u'
        => "கோயில் நேரம்:\n🌅 காலை 6:00 – மதியம் 12:30\n🌇 மாலை 4:00 – இரவு 9:00\n\nTemple Hours:\n🌅 6:00 AM – 12:30 PM\n🌇 4:00 PM – 9:00 PM",

    '/சேவை|பூஜை|அபிஷேகம்|அர்ச்சனை|ஹோமம்|seva|pooja|puja|abhishekam|archana|homam/u'
        => "நாங்கள் வழங்கும் சேவைகள்:\n• அபிஷேகம் (Abhishekam)\n• அர்ச்சனை (Archana)\n• ஹோமம் (Homam)\n• நிவேதனம் (Neivedyam)\n• அலங்காரம் (Alangaram)\n\nSevas page-ல் விவரம் காணலாம் அல்லது நேரடியாக அழைக்கவும். 🙏",

    '/நன்கொடை|தானம்|donat|pay|upi|bank|account|a\/c|கணக்கு|money|transfer|காசோலை|cheque/u'
        => "நன்கொடை வழிகள் 🙏\n"
         . "நன்கொடை வழங்குபவர்கள் வங்கிக் கணக்கிலும் அல்லது காசோலையாகவும் அறக்கட்டளை பெயரில் வழங்கலாம். (வங்கிப் பரிமாற்றம் அல்லது காசோலை மட்டுமே.)\n"
         . "🛕 அறக்கட்டளை: அருள்மிகு ஸ்ரீ ரேணுகாதேவி ஸ்ரீ லிங்கம்மாள் ஸ்ரீ சின்னம்மாள் திருக்கோவில் தர்ம அறக்கட்டளை\n"
         . "🏦 திருநெல்வேலி மத்திய கூட்டுறவு வங்கி, திருவேங்கடம் கிளை\n"
         . "🔢 வங்கி கணக்கு எண்: 713055315 | IFSC CODE: TNSC0011500\n"
         . "✅ 80G வருமான வரிச்சலுகை\n"
         . "🧾 முகவரி தெளிவாக வழங்கினால் மட்டுமே ரசீது அனுப்பி வைக்கப்படும். நேரடியாக வருபவர்கள் ரசீது பெற்றுக் கொள்ளவும். ரசீது வாங்காமல் கொடுக்கும் பணத்திற்கு அறக்கட்டளை பொறுப்பல்ல.\n"
         . "\n"
         . "How to donate\n"
         . "Donations may be made by bank transfer or by cheque in the Trust's name only — no other payment method is offered.\n"
         . "🛕 Trust: Arulmigu Sri Renukadevi Sri Lingammal Sri Chinnammal Temple Dharma Trust\n"
         . "🏦 Tirunelveli Central Co-operative Bank, Thiruvengadam Branch\n"
         . "🔢 A/C No.: 713055315 | IFSC: TNSC0011500\n"
         . "✅ 80G income-tax exemption for donors\n"
         . "🧾 A receipt is sent only if your full address is clearly provided when donating. Please collect a receipt if donating in person. The Trust is not responsible for money given without a receipt.",

    '/முகவரி|எங்கே|எங்கு|address|location|where|direction|map/u'
        => "📍 முகவரி:\n"
         . "புதுப்பட்டி,\n"
         . "திருவேங்கடம் தாலுகா,\n"
         . "தென்காசி மாவட்டம் - 627719\n"
         . "\n"
         . "📍 Address:\n"
         . "Pudupatti,\n"
         . "Thiruvengadam Taluk,\n"
         . "Tenkasi District – 627719",

    '/தொடர்பு|அழை|phone|call|contact|email|mail|மின்னஞ்சல்/u'
        => "📞 தொடர்புக்கு:\n"
         . "தலைவர் S. கெங்கையா – +91 94430 02296\n"
         . "செயலாளர் G. குமார் – +91 73730 16302\n"
         . "பொருளாளர் 1 K. இராஜேந்திரன் – +91 99650 40693\n"
         . "Contact page-ல் உள்ள படிவம் மூலம் செய்தி அனுப்பலாம்.\n"
         . "\n"
         . "📞 Contact:\n"
         . "President S. Gengaiah – +91 94430 02296\n"
         . "Secretary G. Kumar – +91 73730 16302\n"
         . "Treasurer 1 K. Rajendran – +91 99650 40693\n"
         . "You can also send us a message via the form on our Contact page. 🙏",
];

foreach ($rules as $pattern => $reply) {
    if (preg_match($pattern, $msg)) {
        sendJson(['reply' => $reply]);
    }
}

sendJson(['reply' => "நன்றி! 🙏 கோயில் நேரம், சேவைகள், பௌர்ணமி & நிகழ்வுகள், நன்கொடை & அறக்கட்டளை, கமிட்டியார், வரலாறு அல்லது முகவரி பற்றி கேட்கவும்.\n\nI can help with temple timings, sevas, Pournami & events, donations & the Dharma Trust, the temple committee, history, or directions. Please ask away! 🙏"]);
