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
$systemPrompt = <<<PROMPT
You are a helpful, devotional assistant for Sri Mahendra Temple (ஸ்ரீ மகேந்திர ஆலயம்).
Answer ONLY questions about this temple. Information you know:
- Daily timings: Morning 6:00 AM – 12:30 PM | Evening 4:00 PM – 9:00 PM
- Sevas: Abhishekam, Archana, Homam, Neivedyam, Alangaram, Thiruvanandal
- Festivals: Thai Poosam (Jan), Maha Shivaratri (Feb), Panguni Uthiram (Mar), Aadi Pooram (Jul), Karthigai Deepam (Nov)
- Donations: UPI – templemahendra@upi | Bank: Sri Mahendra Temple Trust, SBI
- Address: Temple Street, City, Tamil Nadu – 600 000
- Phone: +91 00000 00000 | Email: info@templemahendra.in
Keep replies concise (2-4 lines). If the user writes in Tamil, reply in Tamil. If in English, reply in English.
Do not answer anything unrelated to this temple.
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
$msg = mb_strtolower($message, 'UTF-8');

$rules = [
    '/வணக்கம்|நமஸ்காரம்|hello|^hi\b|namask/u'
        => "வணக்கம்! 🙏 ஸ்ரீ மகேந்திர ஆலயத்திற்கு வரவேற்கிறோம்.\nNamaskar! Welcome to Sri Mahendra Temple. How can I help you today?",

    '/நேரம்|திற|மூடு|time|timing|hour|open|close/u'
        => "கோயில் நேரம்:\n🌅 காலை 6:00 – மதியம் 12:30\n🌇 மாலை 4:00 – இரவு 9:00\n\nTemple Hours:\n🌅 6:00 AM – 12:30 PM\n🌇 4:00 PM – 9:00 PM",

    '/சேவை|பூஜை|அபிஷேகம்|அர்ச்சனை|ஹோமம்|seva|pooja|puja|abhishekam|archana|homam/u'
        => "நாங்கள் வழங்கும் சேவைகள்:\n• அபிஷேகம் (Abhishekam)\n• அர்ச்சனை (Archana)\n• ஹோமம் (Homam)\n• நிவேதனம் (Neivedyam)\n• அலங்காரம் (Alangaram)\n\nSevas page-ல் விவரம் காணலாம் அல்லது நேரடியாக அழைக்கவும். 🙏",

    '/திருவிழா|நிகழ்|festival|event|poosam|shivaratri|panguni|karthigai|aadi/u'
        => "வரவிருக்கும் திருவிழாக்கள் 🎉\n• தைப்பூசம் – ஜனவரி\n• மகா சிவராத்திரி – பிப்ரவரி\n• பங்குனி உத்திரம் – மார்ச்\n• ஆடி பூரம் – ஜூலை\n• கார்த்திகை தீபம் – நவம்பர்",

    '/நன்கொடை|தானம்|donat|pay|upi|bank|money|transfer/u'
        => "நன்கொடை வழிகள் 🙏\n💳 UPI: templemahendra@upi\n🏦 Bank: Sri Mahendra Temple Trust, SBI\n\nDonations page-ல் மேலும் தகவல் காணலாம்.",

    '/முகவரி|எங்கே|எங்கு|address|location|where|direction|map/u'
        => "📍 முகவரி:\nகோயில் தெரு, நகரம்\nதமிழ்நாடு – 600 000\n\nAddress: Temple Street, City\nTamil Nadu – 600 000",

    '/தொடர்பு|அழை|phone|call|contact|email/u'
        => "📞 +91 00000 00000\n✉️ info@templemahendra.in\n\nContact page-ல் செய்தி அனுப்பலாம்.\nYou can also send a message via our Contact page. 🙏",
];

foreach ($rules as $pattern => $reply) {
    if (preg_match($pattern, $msg)) {
        sendJson(['reply' => $reply]);
    }
}

sendJson(['reply' => "நன்றி! 🙏 கோயில் நேரம், சேவைகள், நிகழ்வுகள், நன்கொடை அல்லது முகவரி பற்றி கேட்கவும்.\n\nI can help with temple timings, sevas, events, donations, or directions. Please ask away! 🙏"]);
