<?php
/**
 * backend/includes/mailer.php — outbound email, with no dependencies.
 *
 * Shared hosting cannot be trusted to deliver mail from PHP's mail(), so the
 * transport is chosen explicitly and every attempt is recorded in `mail_log`:
 *
 *   MAIL_TRANSPORT=smtp   speak SMTP directly to the configured server
 *                         (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 *                          SMTP_SECURE = tls | ssl | none)
 *   MAIL_TRANSPORT=mail   hand off to PHP's mail()
 *   unset / anything else  write the message to the log and record it as
 *                          "logged" — nothing is silently swallowed, and the
 *                          caller is told delivery did not happen so the UI
 *                          can say so instead of pretending.
 *
 * MAIL_FROM / MAIL_FROM_NAME set the sender. SITE_URL builds absolute links.
 *
 * sendMail() takes optional extra headers — List-Unsubscribe for notifications
 * a devotee can opt out of, and the Message-ID the notification service records
 * against a delivery. Every transport sends them and the log transport records
 * them. A name or value with a line break, or one that would replace a header
 * this file writes itself, refuses the whole message (see mailHeaderProblem()).
 */

require_once __DIR__ . '/db.php';

// envValue() and siteUrl() live in helpers.php: emails are not the only thing
// that needs the site's public address — the Open Graph renderer needs it too.
require_once __DIR__ . '/helpers.php';

if (!function_exists('mailEnv')) {
    /** Kept as the name this file has always used for its settings lookups. */
    function mailEnv(string $key, string $default = ''): string
    {
        return envValue($key, $default);
    }
}

/** Record the attempt. Never throws: logging must not break a user flow. */
function mailRecord(string $to, string $subject, string $template, string $status, string $transport, ?string $error = null): void
{
    try {
        getDB()->prepare(
            'INSERT INTO mail_log (to_email, subject, template, status, transport, error) VALUES (:t,:s,:tp,:st,:tr,:e)'
        )->execute([
            ':t'  => mb_substr($to, 0, 190),
            ':s'  => mb_substr($subject, 0, 255),
            ':tp' => mb_substr($template, 0, 40),
            ':st' => $status,
            ':tr' => $transport,
            ':e'  => $error !== null ? mb_substr($error, 0, 500) : null,
        ]);
    } catch (Throwable $e) {
        error_log('[mail_log] could not record: ' . $e->getMessage());
    }
}

/**
 * Minimal SMTP client: EHLO, optional STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA.
 * Returns '' on success or a human-readable error.
 *
 * $extraHeaders are added after the ones this function writes (see
 * mailHeaderProblem() for what is refused). A Message-ID among them replaces
 * the generated one.
 */
function smtpSend(string $to, string $subject, string $html, string $text, array $extraHeaders = []): string
{
    // sendMail() has checked these already; a direct caller gets the same refusal.
    $headerProblem = mailHeaderProblem($extraHeaders);
    if ($headerProblem !== '') return $headerProblem;

    $host   = mailEnv('SMTP_HOST');
    $port   = (int) (mailEnv('SMTP_PORT', '587'));
    $user   = mailEnv('SMTP_USER');
    $pass   = mailEnv('SMTP_PASS');
    $secure = strtolower(mailEnv('SMTP_SECURE', 'tls'));
    $from   = mailEnv('MAIL_FROM', 'no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $fromNm = mailEnv('MAIL_FROM_NAME', 'Temple');

    if ($host === '') return 'SMTP_HOST is not set.';

    $transport = $secure === 'ssl' ? "ssl://$host:$port" : "tcp://$host:$port";
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $fp = @stream_socket_client($transport, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) return "Could not connect to $host:$port ($errstr)";
    stream_set_timeout($fp, 15);

    $read = function () use ($fp): string {
        $out = '';
        while (($line = fgets($fp, 515)) !== false) {
            $out .= $line;
            // last line of a reply has a space in the 4th position
            if (strlen($line) < 4 || $line[3] === ' ') break;
        }
        return $out;
    };
    $cmd = function (string $c) use ($fp, $read): string {
        fwrite($fp, $c . "\r\n");
        return $read();
    };
    $codeOf = fn(string $r): int => (int) substr(trim($r), 0, 3);

    $greet = $read();
    if ($codeOf($greet) !== 220) { fclose($fp); return 'SMTP greeting failed: ' . trim($greet); }

    $ehloHost = preg_replace('/[^A-Za-z0-9.\-]/', '', $_SERVER['HTTP_HOST'] ?? 'localhost') ?: 'localhost';
    $r = $cmd("EHLO $ehloHost");
    if ($codeOf($r) !== 250) { fclose($fp); return 'EHLO refused: ' . trim($r); }

    if ($secure === 'tls') {
        $r = $cmd('STARTTLS');
        if ($codeOf($r) !== 220) { fclose($fp); return 'STARTTLS refused: ' . trim($r); }
        if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            fclose($fp);
            return 'TLS negotiation failed.';
        }
        $r = $cmd("EHLO $ehloHost");
        if ($codeOf($r) !== 250) { fclose($fp); return 'EHLO after STARTTLS refused: ' . trim($r); }
    }

    if ($user !== '') {
        $r = $cmd('AUTH LOGIN');
        if ($codeOf($r) !== 334) { fclose($fp); return 'AUTH LOGIN refused: ' . trim($r); }
        $r = $cmd(base64_encode($user));
        if ($codeOf($r) !== 334) { fclose($fp); return 'SMTP username rejected.'; }
        $r = $cmd(base64_encode($pass));
        if ($codeOf($r) !== 235) { fclose($fp); return 'SMTP password rejected.'; }
    }

    $r = $cmd('MAIL FROM:<' . $from . '>');
    if ($codeOf($r) !== 250) { fclose($fp); return 'MAIL FROM refused: ' . trim($r); }
    $r = $cmd('RCPT TO:<' . $to . '>');
    if (!in_array($codeOf($r), [250, 251], true)) { fclose($fp); return 'Recipient refused: ' . trim($r); }
    $r = $cmd('DATA');
    if ($codeOf($r) !== 354) { fclose($fp); return 'DATA refused: ' . trim($r); }

    $boundary = 'b' . bin2hex(random_bytes(12));
    $headers = [
        'From: ' . mailEncodeName($fromNm) . ' <' . $from . '>',
        'To: <' . $to . '>',
        'Subject: ' . mailEncodeHeader($subject),
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'Date: ' . date('r'),
    ];
    // A caller that must recognise this message later (the notification service
    // stores it against the delivery) supplies its own Message-ID.
    if (!mailHasHeader($extraHeaders, 'Message-ID')) {
        $headers[] = 'Message-ID: <' . bin2hex(random_bytes(10)) . '@' . $ehloHost . '>';
    }
    $headers = array_merge($headers, mailHeaderLines($extraHeaders));
    $body = implode("\r\n", $headers) . "\r\n\r\n"
        . "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($text)) . "\r\n"
        . "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($html)) . "\r\n"
        . "--$boundary--\r\n";
    // dot-stuffing so a line of "." cannot end DATA early
    $body = preg_replace('/^\./m', '..', $body);
    fwrite($fp, $body . "\r\n.\r\n");
    $r = $read();
    if ($codeOf($r) !== 250) { fclose($fp); return 'Message rejected: ' . trim($r); }
    $cmd('QUIT');
    fclose($fp);
    return '';
}

function mailEncodeHeader(string $s): string
{
    return preg_match('/[^\x20-\x7E]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
}
function mailEncodeName(string $s): string
{
    return preg_match('/[^\x20-\x7E]/', $s) ? mailEncodeHeader($s) : '"' . addslashes($s) . '"';
}

/**
 * Why a set of extra headers cannot be sent, or '' when every one is safe.
 *
 * Extra headers exist for List-Unsubscribe and for a Message-ID the
 * notification service can match later. A line break inside a name or value
 * would let whatever follows it become a header of its own — a Bcc to anyone,
 * or a second body — so a message carrying one is refused outright rather than
 * "cleaned": input that tried that is not input to deliver. Headers this file
 * writes itself cannot be replaced from outside either.
 */
function mailHeaderProblem(array $headers): string
{
    $reserved = ['from', 'to', 'cc', 'bcc', 'subject', 'date', 'sender', 'return-path',
                 'mime-version', 'content-type', 'content-transfer-encoding'];
    foreach ($headers as $name => $value) {
        $name = (string) $name;
        if (preg_match('/[\r\n\0]/', $name)) return 'Refused an email header containing a line break';
        if (!preg_match('/^[A-Za-z][A-Za-z0-9-]{0,75}$/', $name)) return 'Refused an email header with an invalid name';
        if (!is_scalar($value)) return 'Refused an email header whose value is not text: ' . $name;
        if (preg_match('/[\r\n\0]/', (string) $value)) return 'Refused an email header containing a line break';
        if (in_array(strtolower($name), $reserved, true)) return 'Refused an email header the mailer sets itself: ' . $name;
        if (strlen((string) $value) > 900) return 'Refused an email header longer than 900 characters: ' . $name;
    }
    return '';
}

/** "Name: value" lines for headers that passed mailHeaderProblem(); non-ASCII values are encoded. */
function mailHeaderLines(array $headers): array
{
    $lines = [];
    foreach ($headers as $name => $value) {
        $lines[] = $name . ': ' . mailEncodeHeader((string) $value);
    }
    return $lines;
}

function mailHasHeader(array $headers, string $name): bool
{
    foreach (array_keys($headers) as $key) {
        if (strcasecmp((string) $key, $name) === 0) return true;
    }
    return false;
}

/**
 * Send a message. Returns ['ok' => bool, 'status' => sent|failed|logged, 'error' => string].
 * `ok` is false whenever the devotee will not receive anything, so callers can
 * tell the truth on screen instead of claiming an email is on its way.
 */
function sendMail(string $to, string $subject, string $html, string $text, string $template = 'generic', array $headers = []): array
{
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
        mailRecord($to, $subject, $template, 'failed', 'none', 'Invalid recipient address');
        return ['ok' => false, 'status' => 'failed', 'error' => 'Invalid recipient address'];
    }

    // Checked before any transport, so a refused header is refused the same way
    // whether the message would have gone by SMTP, mail() or only to the log.
    $headerProblem = mailHeaderProblem($headers);
    if ($headerProblem !== '') {
        mailRecord($to, $subject, $template, 'failed', 'none', $headerProblem);
        error_log("[mail] $headerProblem; message to $to not sent");
        return ['ok' => false, 'status' => 'failed', 'error' => $headerProblem];
    }

    $transport = strtolower(mailEnv('MAIL_TRANSPORT', ''));

    if ($transport === 'smtp') {
        $err = smtpSend($to, $subject, $html, $text, $headers);
        $ok  = $err === '';
        mailRecord($to, $subject, $template, $ok ? 'sent' : 'failed', 'smtp', $ok ? null : $err);
        if (!$ok) error_log("[mail] SMTP failure to $to: $err");
        return ['ok' => $ok, 'status' => $ok ? 'sent' : 'failed', 'error' => $err];
    }

    if ($transport === 'mail') {
        $from    = mailEnv('MAIL_FROM', 'no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost'));
        $fromNm  = mailEnv('MAIL_FROM_NAME', 'Temple');
        $extra   = mailHeaderLines($headers);
        $headerText = "From: " . mailEncodeName($fromNm) . " <$from>\r\n"
                 . "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n"
                 . ($extra ? implode("\r\n", $extra) . "\r\n" : '');
        $ok = @mail($to, mailEncodeHeader($subject), $html, $headerText);
        mailRecord($to, $subject, $template, $ok ? 'sent' : 'failed', 'mail', $ok ? null : 'mail() returned false');
        return ['ok' => (bool) $ok, 'status' => $ok ? 'sent' : 'failed', 'error' => $ok ? '' : 'mail() returned false'];
    }

    // No transport configured: keep the message where a developer can find it.
    // This log holds verification and reset links, which are credentials, so the
    // deny rule is written alongside the directory rather than relying on the
    // one in the repository having survived the upload.
    $dir  = __DIR__ . '/../logs';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $guard = $dir . '/.htaccess';
    if (is_dir($dir) && !file_exists($guard)) {
        @file_put_contents(
            $guard,
            "# Contains password-reset and verification links. Never serve this.\n"
            . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order Allow,Deny\n  Deny from all\n</IfModule>\n"
        );
    }
    $file = $dir . '/mail.log';
    // Extra headers are recorded after Template: so a developer can see the
    // List-Unsubscribe and Message-ID a real transport would have sent. With none,
    // the entry keeps exactly the shape the account test suites read.
    $recorded = mailHeaderLines($headers);
    @file_put_contents(
        $file,
        sprintf(
            "\n===== %s\nTo: %s\nSubject: %s\nTemplate: %s\n%s\n%s\n",
            date('c'), $to, $subject, $template, $recorded ? implode("\n", $recorded) . "\n" : '', $text
        ),
        FILE_APPEND
    );
    mailRecord($to, $subject, $template, 'logged', 'none', 'MAIL_TRANSPORT is not configured');
    error_log("[mail] not configured; wrote $template for $to to backend/logs/mail.log");
    return ['ok' => false, 'status' => 'logged', 'error' => 'Email is not configured on this server.'];
}

/**
 * Wrap body copy in the temple's own visual language. Kept to table layout and
 * inline styles because that is what mail clients render reliably.
 */
function mailTemplate(string $headingTa, string $headingEn, string $bodyHtml, ?string $ctaLabel = null, ?string $ctaUrl = null, ?string $footNote = null): string
{
    $cta = '';
    if ($ctaLabel && $ctaUrl) {
        $cta = '<tr><td style="padding:8px 0 4px"><a href="' . htmlspecialchars($ctaUrl, ENT_QUOTES) . '"'
             . ' style="display:inline-block;background:#991b1b;color:#ffffff;text-decoration:none;'
             . 'font-weight:700;font-size:15px;padding:13px 26px;border-radius:999px">'
             . htmlspecialchars($ctaLabel, ENT_QUOTES) . '</a></td></tr>'
             . '<tr><td style="padding:14px 0 0;font-size:12px;color:#85595c;line-height:1.6">'
             . 'If the button does not work, copy this link into your browser:<br />'
             . '<span style="color:#c2410c;word-break:break-all">' . htmlspecialchars($ctaUrl, ENT_QUOTES) . '</span></td></tr>';
    }
    $foot = $footNote ? '<p style="margin:14px 0 0;font-size:12px;color:#85595c;line-height:1.6">' . $footNote . '</p>' : '';

    return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fffbf5">'
      . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf5;padding:28px 16px">'
      . '<tr><td align="center">'
      . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid rgba(153,27,27,0.14);border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">'
      . '<tr><td style="background:linear-gradient(135deg,#1a0606,#3d0a0a);padding:26px 30px">'
      . '<div style="color:#fde68a;font-size:13px;letter-spacing:0.5px">' . $headingTa . '</div>'
      . '<div style="color:#ffffff;font-size:21px;font-weight:700;margin-top:6px">' . $headingEn . '</div>'
      . '</td></tr>'
      . '<tr><td style="padding:28px 30px;color:#3d1111;font-size:15px;line-height:1.7">'
      . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>' . $bodyHtml . '</td></tr>' . $cta . '</table>'
      . $foot
      . '</td></tr>'
      . '<tr><td style="padding:16px 30px;border-top:1px solid rgba(153,27,27,0.1);background:#fff8f0;color:#85595c;font-size:12px;line-height:1.6">'
      . 'Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple, Pudupatti, Thiruvengadam Taluk, Tenkasi District 627719'
      . '</td></tr>'
      . '</table></td></tr></table></body></html>';
}
