<?php
/**
 * backend/includes/notify/providers/NotifyMetaWhatsAppProvider.php — WhatsApp
 * through Meta's WhatsApp Cloud API, directly.
 *
 *   WHATSAPP_META_TOKEN            a System User access token with whatsapp_business_messaging
 *   WHATSAPP_META_PHONE_NUMBER_ID  the sending number's id (not the number itself)
 *   WHATSAPP_META_APP_SECRET       signs status callbacks (X-Hub-Signature-256)
 *   WHATSAPP_META_VERIFY_TOKEN     any long random string, entered again in the Meta app dashboard
 *   WHATSAPP_META_API_VERSION      v21.0
 *   WHATSAPP_META_BASE_URL         https://graph.facebook.com (overridable for tests)
 *
 * WhatsApp's one rule that shapes everything here: a business may only send
 * free-form text within 24 hours of the person's last message to it. Anything
 * the temple starts — a booking confirmation, a reminder — must use a template
 * Meta has approved, named on the notification template in the admin
 * (provider_template), with its {{1}}, {{2}}… filled from provider_params.
 *
 * URL buttons in a template: Meta fixes the base URL at approval and lets each
 * message supply only a dynamic suffix. A button in NotifyMessage::$buttons
 * that carries a 'suffix' key sends it as that button's parameter; register the
 * template's button as "https://<site>/{{1}}" to use one. Buttons without a
 * suffix are static and send nothing — sending a parameter to a template
 * without a dynamic button is itself an error (132000).
 *
 * Reference: developers.facebook.com/docs/whatsapp/cloud-api (messages,
 * webhooks, error codes), as of 2026.
 */

final class NotifyMetaWhatsAppProvider implements NotifyProvider
{
    /** Transient: rate limits, throughput, "try again later". */
    private const RETRY_CODES = [1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056];

    /** Permanent, with words a committee member can act on. */
    private const REJECT_REASONS = [
        100    => 'WhatsApp (Meta) refused a parameter in the request',
        131026 => 'WhatsApp could not deliver to this number: it may not use WhatsApp, or has not accepted WhatsApp\'s latest terms',
        131047 => 'More than 24 hours have passed since this devotee last wrote to the temple on WhatsApp, so WhatsApp requires an approved template: set one on the template in the admin',
        131051 => 'WhatsApp does not support this type of message',
        133010 => 'The temple\'s WhatsApp number is not registered with the WhatsApp Cloud API',
        132000 => 'The number of parameters does not match the approved WhatsApp template',
        132001 => 'The WhatsApp template does not exist in this language, or is not approved yet',
        132005 => 'The WhatsApp template text is too long once its parameters are filled in',
        132007 => 'The WhatsApp template content breaks WhatsApp policy',
        132012 => 'A WhatsApp template parameter is in the wrong format',
        132015 => 'The WhatsApp template is paused because of low quality ratings',
    ];

    public function name(): string { return 'meta'; }
    public function channel(): string { return 'whatsapp'; }

    public function isConfigured(): bool
    {
        return trim(notifyEnv('WHATSAPP_META_TOKEN')) !== '' && trim(notifyEnv('WHATSAPP_META_PHONE_NUMBER_ID')) !== '';
    }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('meta', function () use ($m): NotifyResult {
            if (!$this->isConfigured()) {
                return NotifyResult::skipped('not configured: WHATSAPP_META_TOKEN and WHATSAPP_META_PHONE_NUMBER_ID are required');
            }
            $to = preg_replace('/\D+/', '', (string) $m->toPhone) ?? '';
            if ($to === '') return NotifyResult::rejected('no phone number');

            $payload = trim((string) $m->providerTemplate) !== ''
                ? $this->templatePayload($m, $to)
                : $this->freeFormPayload($m, $to);
            if ($payload === null) return NotifyResult::rejected('the WhatsApp message is empty');

            $res = notifyHttp('POST', $this->messagesUrl(), [
                'Authorization' => 'Bearer ' . trim(notifyEnv('WHATSAPP_META_TOKEN')),
                'Content-Type'  => 'application/json',
                'Accept'        => 'application/json',
            ], (string) json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), 20);

            return self::interpret($res);
        });
    }

    /**
     * GET  — the one-time subscription check from the Meta dashboard: echo
     *        hub.challenge when hub.verify_token matches.
     * POST — status callbacks, signed with the app secret over the raw body.
     */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return NotifyProviderSupport::guardWebhook('meta', function () use ($method, $headers, $rawBody, $query): array {
            $method = strtoupper($method);
            if ($method === 'GET') return self::verifySubscription($query);
            if ($method !== 'POST') return ['ok' => false, 'status' => 405, 'error' => 'method not allowed'];

            $secret = notifyEnv('WHATSAPP_META_APP_SECRET');
            $sent   = strtolower(trim((string) ($headers['x-hub-signature-256'] ?? '')));
            // No secret configured means nothing can be verified, so nothing is accepted.
            if ($secret === '' || !str_starts_with($sent, 'sha256=')
                || !hash_equals('sha256=' . hash_hmac('sha256', $rawBody, $secret), $sent)) {
                return ['ok' => false, 'status' => 403, 'error' => 'signature mismatch'];
            }

            $updates = [];
            $json = json_decode($rawBody, true);
            foreach ((array) (is_array($json) ? ($json['entry'] ?? []) : []) as $entry) {
                foreach ((array) (is_array($entry) ? ($entry['changes'] ?? []) : []) as $change) {
                    $value = is_array($change) && is_array($change['value'] ?? null) ? $change['value'] : [];
                    foreach ((array) ($value['statuses'] ?? []) as $s) {
                        $update = is_array($s) ? self::statusUpdate($s) : null;
                        if ($update !== null) $updates[] = $update;
                    }
                }
            }
            // Inbound messages arrive on the same URL; they are not ours to handle, and
            // Meta retries anything but a 200 for days, so they are acknowledged too.
            return ['ok' => true, 'status' => 200, 'response' => 'OK', 'content_type' => 'text/plain; charset=utf-8', 'updates' => $updates];
        });
    }

    private function messagesUrl(): string
    {
        return rtrim(notifyEnv('WHATSAPP_META_BASE_URL', 'https://graph.facebook.com'), '/')
            . '/' . trim(notifyEnv('WHATSAPP_META_API_VERSION', 'v21.0'), '/')
            . '/' . rawurlencode(trim(notifyEnv('WHATSAPP_META_PHONE_NUMBER_ID')))
            . '/messages';
    }

    /** An approved template: body parameters in order, plus dynamic URL button suffixes. */
    private function templatePayload(NotifyMessage $m, string $to): array
    {
        $components = [];
        if ($m->templateParams !== []) {
            $components[] = [
                'type'       => 'body',
                'parameters' => array_map(static fn($v) => ['type' => 'text', 'text' => self::param($v)], array_values($m->templateParams)),
            ];
        }
        // The index is the button's position in the template, which the buttons
        // list mirrors; only URL buttons with a dynamic suffix take a parameter.
        foreach (array_values($m->buttons) as $index => $button) {
            if (!is_array($button) || ($button['type'] ?? '') !== 'url') continue;
            $suffix = is_scalar($button['suffix'] ?? null) ? trim((string) $button['suffix']) : '';
            if ($suffix === '') continue;
            $components[] = [
                'type'       => 'button',
                'sub_type'   => 'url',
                'index'      => (string) $index,
                'parameters' => [['type' => 'text', 'text' => $suffix]],
            ];
        }

        $template = ['name' => trim((string) $m->providerTemplate), 'language' => ['code' => self::language($m->lang)]];
        if ($components !== []) $template['components'] = $components;
        return [
            'messaging_product' => 'whatsapp',
            'recipient_type'    => 'individual',
            'to'                => $to,
            'type'              => 'template',
            'template'          => $template,
        ];
    }

    /**
     * Inside the 24-hour window: one URL button becomes an interactive
     * call-to-action message (a real button under the text); otherwise plain
     * text with the link written out and a preview when it holds one.
     */
    private function freeFormPayload(NotifyMessage $m, string $to): ?array
    {
        $urlButtons = array_values(array_filter(
            $m->buttons,
            static fn($b) => is_array($b) && ($b['type'] ?? '') === 'url' && trim((string) ($b['value'] ?? '')) !== ''
        ));

        if (count($urlButtons) === 1) {
            $title = trim($m->title);
            $body  = trim($m->body) !== '' ? trim($m->body) : $title;
            if ($body === '') return null;
            $label = trim((string) ($urlButtons[0]['text'] ?? '')) ?: trim((string) $m->ctaLabel) ?: 'Open';
            $interactive = [
                'type'   => 'cta_url',
                'body'   => ['text' => NotifyProviderSupport::truncate($body, 1024)],
                'action' => [
                    'name'       => 'cta_url',
                    'parameters' => [
                        'display_text' => NotifyProviderSupport::truncate($label, 20),
                        'url'          => trim((string) $urlButtons[0]['value']),
                    ],
                ],
            ];
            if ($title !== '' && $title !== $body) {
                $interactive['header'] = ['type' => 'text', 'text' => NotifyProviderSupport::truncate($title, 60)];
            }
            return [
                'messaging_product' => 'whatsapp',
                'recipient_type'    => 'individual',
                'to'                => $to,
                'type'              => 'interactive',
                'interactive'       => $interactive,
            ];
        }

        $text = NotifyProviderSupport::messageText($m, true);
        if ($text === '') return null;
        return [
            'messaging_product' => 'whatsapp',
            'recipient_type'    => 'individual',
            'to'                => $to,
            'type'              => 'text',
            'text'              => [
                'preview_url' => (bool) preg_match('~https?://~i', $text),
                'body'        => NotifyProviderSupport::truncate($text, 4096),
            ],
        ];
    }

    /** Response → result. messages[0].id is the wamid status callbacks refer to. */
    private static function interpret(array $res): NotifyResult
    {
        $status = (int) $res['status'];
        $body   = $res['body'];
        $json   = NotifyProviderSupport::json($body);

        if ($status >= 200 && $status < 300 && is_string($json['messages'][0]['id'] ?? null)) {
            return NotifyResult::sent($json['messages'][0]['id'], $body);
        }
        if ($status === 0) {
            return NotifyResult::retry('could not reach WhatsApp (Meta): ' . NotifyProviderSupport::describe($res));
        }

        $error  = is_array($json['error'] ?? null) ? $json['error'] : [];
        $code   = (int) ($error['code'] ?? 0);
        $detail = is_string($error['error_data']['details'] ?? null) ? $error['error_data']['details']
                : (is_string($error['message'] ?? null) ? $error['message'] : '');
        $detail = notifyRedact($detail, 200);
        $wait   = NotifyProviderSupport::retryAfter($res['headers']);

        if ($code === 190 || $status === 401) {
            return NotifyResult::retry('Meta refused the WhatsApp access token (WHATSAPP_META_TOKEN): it has expired or been revoked', $body, 3600);
        }
        if ($code === 10 || $code === 3 || ($code >= 200 && $code <= 299)) {
            return NotifyResult::retry('The WhatsApp access token (WHATSAPP_META_TOKEN) lacks permission to send from this number', $body, 3600);
        }
        if ($code === 131031) {
            return NotifyResult::retry('The temple\'s WhatsApp Business account is locked: resolve it in Meta Business Manager', $body, 3600);
        }
        if (in_array($code, self::RETRY_CODES, true) || $status === 429 || $status >= 500) {
            $why = $status === 429 || in_array($code, [4, 80007, 130429, 131048, 131056], true)
                ? 'WhatsApp (Meta) is rate limiting sends'
                : 'WhatsApp (Meta) is temporarily unavailable';
            return NotifyResult::retry($why . ' (' . ($code ? 'error ' . $code . ', ' : '') . 'HTTP ' . $status . ')', $body, $wait);
        }
        if (isset(self::REJECT_REASONS[$code])) {
            return NotifyResult::rejected(self::REJECT_REASONS[$code] . ($code === 100 && $detail !== '' ? ': ' . $detail : ''), $body);
        }
        if ($code >= 132000 && $code <= 132015) {
            return NotifyResult::rejected("WhatsApp refused the template (error $code)" . ($detail !== '' ? ': ' . $detail : ''), $body);
        }
        if ($status >= 200 && $status < 300) {
            return NotifyResult::retry('WhatsApp (Meta) answered without a message id', $body);
        }
        return NotifyResult::rejected('WhatsApp (Meta) refused the message' . ($code ? " (error $code)" : " (HTTP $status)") . ($detail !== '' ? ': ' . $detail : ''), $body);
    }

    private static function verifySubscription(array $query): array
    {
        $mode      = (string) ($query['hub.mode'] ?? $query['hub_mode'] ?? '');
        $token     = (string) ($query['hub.verify_token'] ?? $query['hub_verify_token'] ?? '');
        $challenge = (string) ($query['hub.challenge'] ?? $query['hub_challenge'] ?? '');
        $expected  = notifyEnv('WHATSAPP_META_VERIFY_TOKEN');

        if ($mode !== 'subscribe' || $expected === '' || $token === '' || !hash_equals($expected, $token)) {
            return ['ok' => false, 'status' => 403, 'error' => 'verify token mismatch'];
        }
        // Meta's challenge is a number; anything else is not Meta, and is not echoed.
        if (!preg_match('/^[A-Za-z0-9._-]{1,256}$/', $challenge)) {
            return ['ok' => false, 'status' => 400, 'error' => 'bad challenge'];
        }
        return ['ok' => true, 'status' => 200, 'response' => $challenge, 'content_type' => 'text/plain; charset=utf-8', 'updates' => []];
    }

    /** One entry of value.statuses[] → an update, or null for statuses we do not track. */
    private static function statusUpdate(array $s): ?array
    {
        $id = is_string($s['id'] ?? null) ? trim($s['id']) : '';
        $state = match (strtolower((string) ($s['status'] ?? ''))) {
            'sent'      => 'sent',
            'delivered' => 'delivered',
            'read'      => 'read',
            'failed'    => 'failed',
            default     => null,
        };
        if ($id === '' || $state === null) return null;

        $error = null;
        if ($state === 'failed') {
            $e = is_array($s['errors'][0] ?? null) ? $s['errors'][0] : [];
            $parts = array_filter([
                isset($e['code']) ? 'error ' . (int) $e['code'] : null,
                is_string($e['title'] ?? null) ? $e['title'] : (is_string($e['message'] ?? null) ? $e['message'] : null),
                is_string($e['error_data']['details'] ?? null) ? $e['error_data']['details'] : null,
            ]);
            $error = notifyRedact($parts !== [] ? implode(': ', $parts) : 'WhatsApp reported the message as failed', 300);
        }
        $ts = is_scalar($s['timestamp'] ?? null) ? (string) $s['timestamp'] : '';
        return [
            'message_id' => $id,
            'status'     => $state,
            'error'      => $error,
            'at'         => ctype_digit($ts) ? gmdate('Y-m-d H:i:s', (int) $ts) : null,
        ];
    }

    /**
     * Meta refuses template parameters that are empty or that contain new lines,
     * tabs or more than four consecutive spaces; each would reject the whole message.
     */
    private static function param(mixed $value): string
    {
        $text = is_scalar($value) ? (string) $value : '';
        $text = preg_replace('/[\r\n\t]+/', ' ', $text) ?? $text;
        $text = trim(preg_replace('/ {5,}/', '    ', $text) ?? $text);
        return $text === '' ? '-' : NotifyProviderSupport::truncate($text, 1024);
    }

    /** Meta's language codes: "en" must be a locale ("en_US"); Tamil, Hindi, Telugu, Malayalam and Kannada are bare. */
    private static function language(string $lang): string
    {
        $lang = trim($lang);
        if ($lang === '' || strtolower($lang) === 'en') return 'en_US';
        return preg_match('/^[a-z]{2,3}(_[A-Z]{2})?$/', $lang) ? $lang : 'en_US';
    }
}
