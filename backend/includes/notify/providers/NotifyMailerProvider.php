<?php
/**
 * backend/includes/notify/providers/NotifyMailerProvider.php — email through
 * the site's existing mailer (backend/includes/mailer.php).
 *
 * The mailer already chooses a transport (SMTP, mail(), or the log when
 * MAIL_TRANSPORT is unset) and records every attempt in mail_log, so this class
 * only translates: a NotifyMessage into sendMail(), and sendMail()'s answer
 * into a NotifyResult the queue understands.
 *
 * The Message-ID is chosen here and handed to the mailer as a header, so the
 * delivery row can name the exact message a bounce or a mail-log line refers to.
 *
 * isConfigured() is always true: with no transport the mailer writes the message
 * to backend/logs/mail.log, and the result says recordedOnly so nothing counts
 * it as delivered to a person.
 */

require_once __DIR__ . '/../../mailer.php';

final class NotifyMailerProvider implements NotifyProvider
{
    public function name(): string { return 'mailer'; }
    public function channel(): string { return 'email'; }
    public function isConfigured(): bool { return true; }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('mailer', function () use ($m): NotifyResult {
            $to = trim((string) $m->toEmail);
            if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
                return NotifyResult::rejected('the email address is not valid');
            }

            $headers = $m->headers;
            $messageId = null;
            foreach ($headers as $name => $value) {
                if (strcasecmp((string) $name, 'Message-ID') === 0 && is_scalar($value)) $messageId = (string) $value;
            }
            if ($messageId === null) {
                $messageId = self::messageId($m->deliveryId);
                $headers['Message-ID'] = $messageId;
            }

            $text = NotifyProviderSupport::messageText(new NotifyMessage(
                deliveryId: $m->deliveryId, notificationId: $m->notificationId, channel: $m->channel, lang: $m->lang,
                category: $m->category, priority: $m->priority, title: '', body: $m->body,
                ctaUrl: $m->ctaUrl, ctaLabel: $m->ctaLabel,
            ), true);
            $html = $m->html !== null && trim($m->html) !== '' ? $m->html : self::fallbackHtml($m);
            $result = sendMail($to, $m->title, $html, $text, mb_substr('notify:' . $m->category, 0, 40), $headers);

            $status = (string) ($result['status'] ?? 'failed');
            $error  = (string) ($result['error'] ?? '');
            if ($status === 'sent') {
                return NotifyResult::sent($messageId, 'accepted by the mail transport');
            }
            if ($status === 'logged') {
                return NotifyResult::sent(null, 'logged to backend/logs/mail.log: MAIL_TRANSPORT is not set, so nothing was sent', [], true);
            }
            return self::classify($error);
        });
    }

    /** Bounces arrive as mail, not callbacks; nothing to receive here. */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return ['ok' => false, 'status' => 404, 'error' => 'the mailer receives no callbacks'];
    }

    /**
     * sendMail() reports failures as words; the SMTP ones quote the server's
     * reply, whose first digit is what matters: 4xx means "later", 5xx "never".
     * A 5xx while setting up the session (greeting, EHLO, AUTH, MAIL FROM) is
     * about the temple's own mail settings, not this recipient, so it waits
     * for someone to fix them instead of permanently failing every message.
     */
    private static function classify(string $error): NotifyResult
    {
        $shown = notifyRedact($error, 250);
        if ($error === 'Invalid recipient address') {
            return NotifyResult::rejected('the email address is not valid');
        }
        if (str_starts_with($error, 'Refused an email header')) {
            return NotifyResult::rejected($error);
        }
        if (preg_match('/^(Recipient refused|Message rejected): ([245])\d\d/', $error, $mm)) {
            return $mm[2] === '5'
                ? NotifyResult::rejected('the mail server refused the message: ' . $shown, $shown)
                : NotifyResult::retry('the mail server asked to try later: ' . $shown, $shown);
        }
        if (str_contains($error, 'username rejected') || str_contains($error, 'password rejected') || str_starts_with($error, 'AUTH LOGIN refused')) {
            return NotifyResult::retry('the mail server refused the SMTP username or password (SMTP_USER / SMTP_PASS)', $shown, 3600);
        }
        if (preg_match('/:\s*5\d\d\b/', $error) || $error === 'SMTP_HOST is not set.') {
            return NotifyResult::retry('the mail server refused the temple\'s mail session: check the SMTP settings (' . $shown . ')', $shown, 3600);
        }
        return NotifyResult::retry('email could not be sent right now: ' . $shown, $shown);
    }

    /** "<notify.42.a1b2c3d4e5f60718@temple.example>" — unique, and traceable to the delivery. */
    private static function messageId(int $deliveryId): string
    {
        $from   = trim(notifyEnv('MAIL_FROM'));
        $domain = filter_var($from, FILTER_VALIDATE_EMAIL) ? substr($from, strrpos($from, '@') + 1) : (string) parse_url(siteUrl(), PHP_URL_HOST);
        $domain = preg_replace('/[^A-Za-z0-9.-]/', '', $domain) ?: 'localhost';
        return '<notify.' . $deliveryId . '.' . bin2hex(random_bytes(8)) . '@' . $domain . '>';
    }

    /**
     * Used only when the service did not supply HTML. Plain paragraphs and a
     * link, escaped, so a message is never sent as an empty HTML part.
     */
    private static function fallbackHtml(NotifyMessage $m): string
    {
        $paragraphs = '';
        foreach (preg_split('/\n\s*\n/', trim($m->body)) ?: [] as $p) {
            if (trim($p) === '') continue;
            $paragraphs .= '<p style="margin:0 0 14px;font-size:16px;line-height:1.6">' . nl2br(htmlspecialchars(trim($p), ENT_QUOTES, 'UTF-8')) . '</p>';
        }
        $link = NotifyProviderSupport::absoluteUrl($m->ctaUrl);
        if ($link !== null) {
            $paragraphs .= '<p style="margin:0;font-size:16px"><a href="' . htmlspecialchars($link, ENT_QUOTES, 'UTF-8') . '">'
                . htmlspecialchars(trim((string) $m->ctaLabel) !== '' ? (string) $m->ctaLabel : $link, ENT_QUOTES, 'UTF-8') . '</a></p>';
        }
        return '<!DOCTYPE html><html lang="' . htmlspecialchars($m->lang, ENT_QUOTES, 'UTF-8') . '"><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3d1111">'
            . '<h1 style="margin:0 0 16px;font-size:20px">' . htmlspecialchars($m->title, ENT_QUOTES, 'UTF-8') . '</h1>'
            . $paragraphs . '</body></html>';
    }
}
