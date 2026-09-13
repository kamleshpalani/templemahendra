<?php
/**
 * backend/includes/notify/providers/NotifyProviderSupport.php — the pieces every
 * provider needs done the same way.
 *
 * Reading Retry-After, decoding a response body without trusting it, turning a
 * site path into an absolute link, composing the plain text of a free-form
 * message, combining per-device push outcomes into one result, and making sure
 * nothing a provider does can escape as an exception into the worker.
 *
 * Static methods on a class rather than plain functions because the provider
 * autoloader in contracts.php loads classes by name: a function file would need
 * an explicit require in every provider, and forgetting one is a fatal error
 * that only shows up when that one provider is configured in production.
 */

final class NotifyProviderSupport
{
    /**
     * Seconds to wait from a Retry-After header, which may be delta-seconds or an
     * HTTP date. Capped at a day so a misbehaving provider cannot park a delivery
     * for a month; null when the header is absent or unusable.
     */
    public static function retryAfter(array $headers): ?int
    {
        $value = trim((string) ($headers['retry-after'] ?? ''));
        if ($value === '') return null;
        if (ctype_digit($value)) return min(86400, max(1, (int) $value));
        $at = strtotime($value);
        if ($at === false) return null;
        return min(86400, max(1, $at - time()));
    }

    /** A JSON object or list from a response body; [] for anything else. */
    public static function json(string $body): array
    {
        if ($body === '') return [];
        $decoded = json_decode($body, true);
        return is_array($decoded) ? $decoded : [];
    }

    /** "HTTP 503" or "network error: …" — for reasons shown in the admin. */
    public static function describe(array $response): string
    {
        return (int) $response['status'] === 0
            ? 'network error: ' . ($response['error'] !== '' ? $response['error'] : 'no response')
            : 'HTTP ' . (int) $response['status'];
    }

    /**
     * Shorten text to at most $max characters, ending with an ellipsis when cut.
     * Character-based, because the limits providers publish (WhatsApp's 1024,
     * Twilio's 1600) count characters, and Tamil is three bytes a character.
     */
    public static function truncate(string $text, int $max): string
    {
        if ($max < 1) return '';
        if (mb_strlen($text) <= $max) return $text;
        return rtrim(mb_substr($text, 0, max(0, $max - 1))) . '…';
    }

    /**
     * An absolute http(s) URL for a link: site paths go through siteUrl(),
     * absolute http(s) URLs pass through, anything else is dropped. Protocol-
     * relative "//host" is refused because it would leave the site's origin.
     */
    public static function absoluteUrl(?string $url): ?string
    {
        $url = trim((string) $url);
        if ($url === '') return null;
        if (str_starts_with($url, '/') && !str_starts_with($url, '//')) return siteUrl($url);
        return preg_match('~^https?://[^\s/]+~i', $url) ? $url : null;
    }

    /** Only an absolute https URL, for fields a provider refuses otherwise (FCM image and link). */
    public static function httpsUrl(?string $url): ?string
    {
        $absolute = self::absoluteUrl($url);
        return $absolute !== null && stripos($absolute, 'https://') === 0 ? $absolute : null;
    }

    /**
     * The words of a free-form WhatsApp or SMS message.
     *
     * The service renders a channel-specific body; the title is added only where
     * it helps (WhatsApp, in bold, when the body does not already open with it)
     * and the call-to-action link is appended only when the body does not carry
     * it already — a devotee who cannot follow the link cannot act on the message.
     * SMS stays lean: no label before the link, because every character costs.
     */
    public static function messageText(NotifyMessage $m, bool $formatted): string
    {
        $body  = trim($m->body);
        $title = trim($m->title);
        if ($formatted && $title !== '' && !str_starts_with($body, $title)) {
            $bold = trim(str_replace('*', '', $title));
            $body = ($bold !== '' ? '*' . $bold . '*' : $title) . ($body !== '' ? "\n\n" . $body : '');
        } elseif ($body === '') {
            $body = $title;
        }
        $link = self::absoluteUrl($m->ctaUrl);
        if ($link !== null && !str_contains($body, $link)) {
            $label = $formatted && trim((string) $m->ctaLabel) !== '' ? trim((string) $m->ctaLabel) . ': ' : '';
            $body .= ($body !== '' ? "\n\n" : '') . $label . $link;
        }
        return $body;
    }

    /**
     * Combine per-device push outcomes into the delivery's result (SPEC §5.7).
     *
     * @param array $devices deviceId => ['ok' => bool, 'gone' => bool, 'retry' => bool, 'reason' => string]
     *
     *   any device accepted                  → sent (gone devices still reported, so they are retired)
     *   every device gone                    → rejected "every device is gone"
     *   nothing left that a retry could fix  → rejected with the first refusal's reason
     *   otherwise                            → retry
     *
     * The third rule is the one judgement call: a 413 or 400 from every device
     * will be a 413 or 400 next time too, so retrying would only burn attempts.
     */
    public static function pushOutcome(array $devices, ?string $messageId, string $response, ?int $retryAfter, string $label): NotifyResult
    {
        if ($devices === []) return NotifyResult::skipped('no ' . $label . ' device');

        $ok = $gone = $retryable = 0;
        $firstRefusal = $firstRetry = null;
        foreach ($devices as $d) {
            if (!empty($d['ok'])) { $ok++; continue; }
            if (!empty($d['gone'])) { $gone++; continue; }
            if (!empty($d['retry'])) {
                $retryable++;
                $firstRetry ??= (string) ($d['reason'] ?? '');
            } else {
                $firstRefusal ??= (string) ($d['reason'] ?? '');
            }
        }

        if ($ok > 0) return NotifyResult::sent($messageId, $response, $devices);
        if ($gone === count($devices)) return NotifyResult::rejected('every device is gone', $response, $devices);
        if ($retryable === 0) return NotifyResult::rejected((string) $firstRefusal, $response, $devices);
        return NotifyResult::retry((string) $firstRetry, $response, $retryAfter, $devices);
    }

    /**
     * Run a provider's send so that nothing escapes. The interface promises the
     * worker a result, never an exception; an unexpected error becomes a retry,
     * and the log line is redacted because exception messages can quote input.
     */
    public static function guard(string $provider, callable $send): NotifyResult
    {
        try {
            $result = $send();
            return $result instanceof NotifyResult
                ? $result
                : NotifyResult::retry('the ' . $provider . ' provider returned no result');
        } catch (Throwable $e) {
            error_log(sprintf('[notify] %s provider error: %s: %s', $provider, get_class($e), notifyRedact($e->getMessage(), 300)));
            return NotifyResult::retry('unexpected error in the ' . $provider . ' provider');
        }
    }

    /** The same promise for handleWebhook(): an error answers 500 so the provider redelivers. */
    public static function guardWebhook(string $provider, callable $handle): array
    {
        try {
            $result = $handle();
            return is_array($result) ? $result : ['ok' => false, 'status' => 500, 'error' => 'no result'];
        } catch (Throwable $e) {
            error_log(sprintf('[notify] %s webhook error: %s: %s', $provider, get_class($e), notifyRedact($e->getMessage(), 300)));
            return ['ok' => false, 'status' => 500, 'error' => 'internal error'];
        }
    }

    /**
     * Parse an application/x-www-form-urlencoded body into name => [values].
     *
     * Not parse_str(): it rewrites dots and spaces in names and folds "a[]" into
     * arrays, and a signature computed over rewritten names does not match the
     * one the provider computed over what it actually sent.
     */
    public static function parseForm(string $raw): array
    {
        $out = [];
        foreach (explode('&', $raw) as $pair) {
            if ($pair === '') continue;
            $parts = explode('=', $pair, 2);
            $out[urldecode($parts[0])][] = urldecode($parts[1] ?? '');
        }
        return $out;
    }

    /** First value of each form field, for payloads that are not signed field by field. */
    public static function formFirst(array $form): array
    {
        $flat = [];
        foreach ($form as $name => $values) $flat[(string) $name] = (string) ($values[0] ?? '');
        return $flat;
    }
}
