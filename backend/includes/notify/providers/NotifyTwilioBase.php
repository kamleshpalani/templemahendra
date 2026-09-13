<?php
/**
 * backend/includes/notify/providers/NotifyTwilioBase.php — what Twilio's
 * WhatsApp and SMS drivers share: one Messages endpoint, one account, one
 * status callback format and one signature scheme.
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_BASE_URL             https://api.twilio.com (overridable for tests)
 *   TWILIO_STATUS_CALLBACK_URL  default siteUrl('/api/notify-webhook/twilio')
 *
 * Twilio answers a send with 201 and a Message SID, then reports queued → sent
 * → delivered (→ read, on WhatsApp) or undelivered/failed to the status
 * callback. Error codes a committee member can act on get plain words.
 *
 * Reference: twilio.com/docs/messaging/api/message-resource,
 * /docs/usage/webhooks/webhooks-security, /docs/api/errors (as of 2026).
 */

abstract class NotifyTwilioBase implements NotifyProvider
{
    private const REJECT_REASONS = [
        21211 => 'Twilio says this is not a valid phone number',
        21408 => 'The Twilio account is not allowed to send to this country or region: enable it in the Twilio console',
        21610 => 'This devotee replied STOP to the temple\'s number and cannot be messaged until they reply START',
        21614 => 'This number cannot receive text messages (it is not a mobile number)',
        63016 => 'More than 24 hours have passed since this devotee last wrote on WhatsApp, so an approved template (a Twilio Content SID) is required',
        63024 => 'This number is not a valid WhatsApp recipient for the temple\'s sender',
    ];

    public function name(): string { return 'twilio'; }

    /** The sender fields: ['From' => …] or ['MessagingServiceSid' => …]; [] when not configured. */
    abstract protected function senderFields(): array;

    /** The To value for an E.164 number ("+91…" or "whatsapp:+91…"). */
    abstract protected function toAddress(string $e164): string;

    /** Body, ContentSid + ContentVariables or MediaUrl — or a result when the message cannot be sent. */
    abstract protected function contentFields(NotifyMessage $m): array|NotifyResult;

    public function isConfigured(): bool
    {
        return self::accountSid() !== '' && notifyEnv('TWILIO_AUTH_TOKEN') !== '' && $this->senderFields() !== [];
    }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('twilio', function () use ($m): NotifyResult {
            if (!$this->isConfigured()) {
                return NotifyResult::skipped('not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender are required');
            }
            $e164 = $m->phoneE164();
            if ($e164 === null) return NotifyResult::rejected('no phone number');

            $content = $this->contentFields($m);
            if ($content instanceof NotifyResult) return $content;

            $form = ['To' => $this->toAddress($e164)] + $this->senderFields() + $content + [
                'StatusCallback' => self::statusCallbackUrl(),
            ];
            $sid = self::accountSid();
            $res = notifyHttp(
                'POST',
                rtrim(notifyEnv('TWILIO_BASE_URL', 'https://api.twilio.com'), '/') . '/2010-04-01/Accounts/' . rawurlencode($sid) . '/Messages.json',
                [
                    'Authorization' => 'Basic ' . base64_encode($sid . ':' . notifyEnv('TWILIO_AUTH_TOKEN')),
                    'Content-Type'  => 'application/x-www-form-urlencoded',
                    'Accept'        => 'application/json',
                ],
                $form,
                20
            );
            return self::interpret($res);
        });
    }

    /**
     * Status callbacks. Twilio signs each with X-Twilio-Signature:
     *   base64(HMAC-SHA1(auth token, full URL + every POST name and value, names sorted))
     * so the URL must be the exact one Twilio called — the webhook endpoint
     * rebuilds it from SITE_URL, because behind a proxy the server's own idea of
     * its scheme and host can differ from the public one.
     */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return NotifyProviderSupport::guardWebhook('twilio', function () use ($method, $headers, $rawBody, $requestUrl): array {
            $token = notifyEnv('TWILIO_AUTH_TOKEN');
            $sent  = trim((string) ($headers['x-twilio-signature'] ?? ''));
            if (strtoupper($method) !== 'POST' || $token === '' || $sent === '') {
                return ['ok' => false, 'status' => 403, 'error' => 'signature mismatch'];
            }
            $form = NotifyProviderSupport::parseForm($rawBody);
            if (!self::signatureMatches($token, $sent, $requestUrl, $form)) {
                return ['ok' => false, 'status' => 403, 'error' => 'signature mismatch'];
            }

            $fields  = NotifyProviderSupport::formFirst($form);
            $sid     = trim($fields['MessageSid'] ?? ($fields['SmsSid'] ?? ''));
            $state   = strtolower(trim($fields['MessageStatus'] ?? ($fields['SmsStatus'] ?? '')));
            $mapped  = match ($state) {
                'accepted', 'scheduled', 'queued', 'sending', 'sent' => 'sent',
                'delivered'                                        => 'delivered',
                'read'                                             => 'read',
                'undelivered', 'failed', 'canceled'                => 'failed',
                default                                            => null,
            };

            $updates = [];
            if ($sid !== '' && $mapped !== null) {
                $error = null;
                if ($mapped === 'failed') {
                    $code  = trim($fields['ErrorCode'] ?? '');
                    $words = trim($fields['ErrorMessage'] ?? '');
                    $error = notifyRedact(
                        ($code !== '' ? 'Twilio error ' . $code : 'Twilio reported the message as ' . $state)
                        . (ctype_digit($code) && isset(self::REJECT_REASONS[(int) $code]) ? ': ' . self::REJECT_REASONS[(int) $code] : ($words !== '' ? ': ' . $words : '')),
                        300
                    );
                }
                // Twilio's callbacks carry no event time; the service records its own.
                $updates[] = ['message_id' => $sid, 'status' => $mapped, 'error' => $error, 'at' => null];
            }
            return [
                'ok'           => true,
                'status'       => 200,
                'response'     => '<Response></Response>',
                'content_type' => 'text/xml; charset=utf-8',
                'updates'      => $updates,
            ];
        });
    }

    protected static function accountSid(): string
    {
        return trim(notifyEnv('TWILIO_ACCOUNT_SID'));
    }

    private static function statusCallbackUrl(): string
    {
        $configured = trim(notifyEnv('TWILIO_STATUS_CALLBACK_URL'));
        return $configured !== '' ? $configured : siteUrl('/api/notify-webhook/twilio');
    }

    private static function interpret(array $res): NotifyResult
    {
        $status = (int) $res['status'];
        $body   = $res['body'];
        $json   = NotifyProviderSupport::json($body);

        if (($status === 200 || $status === 201) && is_string($json['sid'] ?? null) && $json['sid'] !== '') {
            return NotifyResult::sent($json['sid'], $body);
        }
        if ($status === 0) {
            return NotifyResult::retry('could not reach Twilio: ' . NotifyProviderSupport::describe($res));
        }

        $code  = (int) ($json['code'] ?? 0);
        $words = notifyRedact(is_string($json['message'] ?? null) ? $json['message'] : '', 200);

        if ($status === 401 || $code === 20003) {
            return NotifyResult::retry('Twilio refused the account credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)', $body, 3600);
        }
        if ($status === 429 || $code === 20429) {
            return NotifyResult::retry('Twilio is rate limiting sends (HTTP ' . $status . ')', $body, NotifyProviderSupport::retryAfter($res['headers']));
        }
        if ($status >= 500) {
            return NotifyResult::retry('Twilio is temporarily unavailable (HTTP ' . $status . ')', $body, NotifyProviderSupport::retryAfter($res['headers']));
        }
        if (isset(self::REJECT_REASONS[$code])) {
            return NotifyResult::rejected(self::REJECT_REASONS[$code], $body);
        }
        if ($status >= 400) {
            return NotifyResult::rejected('Twilio refused the message' . ($code ? " (error $code)" : " (HTTP $status)") . ($words !== '' ? ': ' . $words : ''), $body);
        }
        return NotifyResult::retry('Twilio answered without a message SID (HTTP ' . $status . ')', $body);
    }

    /**
     * Compare against the URL as given and with its default port toggled: which
     * form Twilio signed depends on how the webhook URL was entered, and Twilio's
     * own validators accept both for that reason.
     */
    private static function signatureMatches(string $token, string $sent, string $url, array $form): bool
    {
        ksort($form, SORT_STRING);
        $data = '';
        foreach ($form as $name => $values) {
            $values = array_map('strval', $values);
            sort($values, SORT_STRING);
            foreach ($values as $value) $data .= $name . $value;
        }
        foreach (self::urlVariants($url) as $candidate) {
            if (hash_equals(base64_encode(hash_hmac('sha1', $candidate . $data, $token, true)), $sent)) return true;
        }
        return false;
    }

    private static function urlVariants(string $url): array
    {
        $variants = [$url];
        $p = parse_url($url);
        if (!is_array($p) || empty($p['host']) || empty($p['scheme'])) return $variants;
        $scheme  = strtolower($p['scheme']);
        $default = $scheme === 'https' ? 443 : ($scheme === 'http' ? 80 : null);
        if ($default === null) return $variants;
        $tail = ($p['path'] ?? '') . (isset($p['query']) ? '?' . $p['query'] : '');
        if (!isset($p['port'])) {
            $variants[] = $scheme . '://' . $p['host'] . ':' . $default . $tail;
        } elseif ((int) $p['port'] === $default) {
            $variants[] = $scheme . '://' . $p['host'] . $tail;
        }
        return $variants;
    }
}
