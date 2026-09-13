<?php
/**
 * backend/includes/notify/providers/NotifyMsg91SmsProvider.php — SMS in India
 * through MSG91's Flow API.
 *
 *   MSG91_AUTH_KEY       the account's auth key (sent as the "authkey" header)
 *   MSG91_BASE_URL       https://control.msg91.com (overridable for tests)
 *   MSG91_WEBHOOK_TOKEN  a long random string; see handleWebhook() for why it is in the URL
 *   MSG91_SENDER_ID, MSG91_ROUTE, MSG91_DLT_ENTITY_ID
 *                        belong to the flow template itself in the MSG91 panel,
 *                        where DLT registration ties sender, entity and wording
 *                        together; the Flow API takes only the template id.
 *
 * Indian regulation (TRAI DLT) allows no free text: every SMS must match a
 * pre-registered template word for word, with its variables in marked places.
 * So a message without a template id is refused here rather than sent to fail.
 * The template's ##var1##, ##var2##… are filled from provider_params in order.
 *
 * Reference: docs.msg91.com (Send SMS: /api/v5/flow, delivery report webhooks),
 * as of 2026. MSG91 documents its delivery-report payload loosely and has
 * changed its shape over the years, so the parser accepts the known variants.
 */

final class NotifyMsg91SmsProvider implements NotifyProvider
{
    public function name(): string { return 'msg91'; }
    public function channel(): string { return 'sms'; }

    public function isConfigured(): bool
    {
        return trim(notifyEnv('MSG91_AUTH_KEY')) !== '';
    }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('msg91', function () use ($m): NotifyResult {
            if (!$this->isConfigured()) return NotifyResult::skipped('not configured: MSG91_AUTH_KEY is required');

            $mobile = preg_replace('/\D+/', '', (string) $m->toPhone) ?? '';
            if ($mobile === '') return NotifyResult::rejected('no phone number');

            $template = trim((string) $m->providerTemplate);
            if ($template === '') {
                return NotifyResult::rejected('MSG91 needs a DLT-approved template id - set it on the template in the admin');
            }

            $recipient = ['mobiles' => $mobile];
            foreach (array_values($m->templateParams) as $i => $value) {
                $recipient['var' . ($i + 1)] = is_scalar($value) ? (string) $value : '';
            }
            $res = notifyHttp('POST', rtrim(notifyEnv('MSG91_BASE_URL', 'https://control.msg91.com'), '/') . '/api/v5/flow/', [
                'authkey'      => trim(notifyEnv('MSG91_AUTH_KEY')),
                'Content-Type' => 'application/json',
                'Accept'       => 'application/json',
            ], (string) json_encode([
                'template_id' => $template,
                // MSG91's link shortener would rewrite our signed tracking links.
                'short_url'   => '0',
                'recipients'  => [$recipient],
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), 20);

            return self::interpret($res);
        });
    }

    /**
     * Delivery reports.
     *
     * MSG91 signs nothing, so the only proof a report came from MSG91 is a shared
     * secret in the callback URL (?token=…), compared in constant time. The
     * trade-off: a URL is written to access logs — the web server's, and any
     * proxy's — where a header would not be. It is acceptable because this token
     * is not an API credential: it only lets someone post delivery statuses,
     * statuses only ever move a delivery forward, and they only touch message
     * ids that exist. Use a long random value dedicated to this, rotate it by
     * changing MSG91_WEBHOOK_TOKEN and the URL in the MSG91 panel together, and
     * restrict the endpoint to MSG91's addresses at the host if the plan allows.
     */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return NotifyProviderSupport::guardWebhook('msg91', function () use ($method, $headers, $rawBody, $query): array {
            $expected = notifyEnv('MSG91_WEBHOOK_TOKEN');
            $given    = is_string($query['token'] ?? null) ? $query['token'] : '';
            if ($expected === '' || $given === '' || !hash_equals($expected, $given)) {
                return ['ok' => false, 'status' => 403, 'error' => 'token mismatch'];
            }

            $payload = self::payload($method, (string) ($headers['content-type'] ?? ''), $rawBody, $query);
            $updates = [];
            self::collect($payload, null, $updates, 0);
            return ['ok' => true, 'status' => 200, 'response' => '{"ok":true}', 'content_type' => 'application/json; charset=utf-8', 'updates' => $updates];
        });
    }

    private static function interpret(array $res): NotifyResult
    {
        $status = (int) $res['status'];
        $body   = $res['body'];
        $json   = NotifyProviderSupport::json($body);
        $type   = strtolower(is_string($json['type'] ?? null) ? $json['type'] : '');

        if ($status >= 200 && $status < 300 && $type === 'success') {
            // On success, "message" is the request id that delivery reports quote.
            $requestId = is_scalar($json['message'] ?? null) ? trim((string) $json['message'])
                       : (is_scalar($json['request_id'] ?? null) ? trim((string) $json['request_id']) : '');
            return NotifyResult::sent($requestId !== '' ? $requestId : null, $body);
        }
        if ($status === 0) {
            return NotifyResult::retry('could not reach MSG91: ' . NotifyProviderSupport::describe($res));
        }
        if ($status === 429 || $status >= 500) {
            return NotifyResult::retry('MSG91 is ' . ($status === 429 ? 'rate limiting sends' : 'temporarily unavailable') . ' (HTTP ' . $status . ')', $body, NotifyProviderSupport::retryAfter($res['headers']));
        }

        $words = is_scalar($json['message'] ?? null) ? trim((string) $json['message']) : '';
        $lower = strtolower($words);
        $code  = is_scalar($json['code'] ?? null) ? (string) $json['code'] : '';
        $shown = notifyRedact($words, 200);

        if ($status === 401 || $status === 403 || str_contains($lower, 'auth') || str_contains($lower, 'whitelist') || in_array($code, ['201', '207', '418'], true)) {
            return NotifyResult::retry('MSG91 refused the auth key (MSG91_AUTH_KEY): check it, and any IP whitelist on the MSG91 account', $body, 3600);
        }
        if (str_contains($lower, 'balance') || str_contains($lower, 'credit')) {
            return NotifyResult::retry('The MSG91 account has run out of SMS credit', $body, 3600);
        }
        if (str_contains($lower, 'mobile') || str_contains($lower, 'number')) {
            return NotifyResult::rejected('MSG91 says the mobile number is not valid' . ($shown !== '' ? ': ' . $shown : ''), $body);
        }
        if (str_contains($lower, 'template') || str_contains($lower, 'flow') || str_contains($lower, 'dlt')) {
            return NotifyResult::rejected('MSG91 refused the template id: check the DLT template id on the template in the admin' . ($shown !== '' ? ' (' . $shown . ')' : ''), $body);
        }
        if ($status >= 400 || $type === 'error') {
            return NotifyResult::rejected('MSG91 refused the message' . ($shown !== '' ? ': ' . $shown : " (HTTP $status)"), $body);
        }
        return NotifyResult::retry('MSG91 answered with an unexpected response (HTTP ' . $status . ')', $body);
    }

    /** The report as an array: JSON, a form with a JSON "data" field, a plain form, or GET parameters. */
    private static function payload(string $method, string $contentType, string $rawBody, array $query): array
    {
        $raw = trim($rawBody);
        if ($raw !== '') {
            $json = json_decode($raw, true);
            if (is_array($json)) return $json;
            $form = NotifyProviderSupport::formFirst(NotifyProviderSupport::parseForm($raw));
            if (isset($form['data'])) {
                $data = json_decode($form['data'], true);
                if (is_array($data)) return $data;
            }
            return $form;
        }
        if (strtoupper($method) === 'GET') {
            unset($query['token']);
            return $query;
        }
        return [];
    }

    /**
     * Walk a report and collect updates. A request id may sit on the item or on a
     * parent whose "report"/"numbers"/"data" list holds the per-number statuses.
     */
    private static function collect(mixed $node, ?string $requestId, array &$updates, int $depth): void
    {
        if (!is_array($node) || $depth > 6) return;
        if (array_is_list($node)) {
            foreach ($node as $child) self::collect($child, $requestId, $updates, $depth + 1);
            return;
        }

        $rid = $node['requestId'] ?? $node['request_id'] ?? $node['requestid'] ?? null;
        $rid = is_scalar($rid) && trim((string) $rid) !== '' ? trim((string) $rid) : $requestId;

        $nested = false;
        foreach (['data', 'report', 'reports', 'numbers'] as $key) {
            if (isset($node[$key]) && is_array($node[$key])) {
                self::collect($node[$key], $rid, $updates, $depth + 1);
                $nested = true;
            }
        }
        if ($nested || $rid === null) return;

        $status = is_scalar($node['status'] ?? null) ? trim((string) $node['status']) : '';
        $desc   = $node['desc'] ?? $node['description'] ?? $node['statusDesc'] ?? null;
        $desc   = is_scalar($desc) ? trim((string) $desc) : '';
        $mapped = self::mapStatus($status, $desc);
        if ($mapped === null) return;

        $updates[] = [
            'message_id' => $rid,
            'status'     => $mapped,
            'error'      => in_array($mapped, ['failed', 'rejected'], true)
                ? notifyRedact($desc !== '' ? 'MSG91: ' . $desc : 'MSG91 status ' . $status, 300)
                : null,
            'at'         => self::reportTime($node['date'] ?? $node['deliveredAt'] ?? $node['time'] ?? null),
        ];
    }

    /**
     * Words first (desc "DELIVERED", status "delivered"), then MSG91's numeric
     * codes: 1 delivered; 2 failed; 9 NDNC and 17 blocked are failures; 16, 25
     * and 26 are operator rejections. Unknown codes are ignored, not guessed.
     */
    private static function mapStatus(string $status, string $desc): ?string
    {
        $words = strtolower(trim($desc . ' ' . (ctype_digit($status) ? '' : $status)));
        if ($words !== '') {
            if (str_contains($words, 'undeliver')) return 'failed';
            if (str_contains($words, 'deliver')) return 'delivered';
            if (str_contains($words, 'reject')) return 'rejected';
            foreach (['fail', 'ndnc', 'block', 'expire', 'dnd'] as $word) {
                if (str_contains($words, $word)) return 'failed';
            }
            foreach (['sent', 'submit', 'pending', 'queue', 'accepted'] as $word) {
                if (str_contains($words, $word)) return 'sent';
            }
        }
        return match ($status) {
            '1'             => 'delivered',
            '2', '9', '17'  => 'failed',
            '16', '25', '26' => 'rejected',
            default         => null,
        };
    }

    /** MSG91 report times are Indian Standard Time wall clock ("Y-m-d H:i:s"); stored as UTC. */
    private static function reportTime(mixed $value): ?string
    {
        if (!is_scalar($value)) return null;
        $text = trim((string) $value);
        if (ctype_digit($text) && strlen($text) >= 10) return gmdate('Y-m-d H:i:s', (int) substr($text, 0, 10));
        $at = DateTimeImmutable::createFromFormat('Y-m-d H:i:s', $text, new DateTimeZone('Asia/Kolkata'));
        return $at === false ? null : $at->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }
}
