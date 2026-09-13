<?php
/**
 * backend/includes/notify/providers/NotifyTwilioSmsProvider.php — SMS through
 * Twilio.
 *
 *   TWILIO_SMS_FROM               a Twilio number in E.164, "+14155550100"
 *   TWILIO_MESSAGING_SERVICE_SID  or a Messaging Service ("MG…"), used when no From is set
 *
 * A Messaging Service is the better choice abroad: it picks a sender per
 * country and handles registration rules. For India, DLT registration is done
 * on the Twilio side; MSG91 is the cheaper route there (NOTIFY_SMS_DRIVER=msg91).
 *
 * The rendered SMS variant is sent as it is, with the link appended only when
 * the text does not already carry it. No title: every character costs, and the
 * SMS templates are written to stand alone.
 */

final class NotifyTwilioSmsProvider extends NotifyTwilioBase
{
    public function channel(): string { return 'sms'; }

    protected function senderFields(): array
    {
        $from = trim(notifyEnv('TWILIO_SMS_FROM'));
        if ($from !== '') return ['From' => $from];
        $service = trim(notifyEnv('TWILIO_MESSAGING_SERVICE_SID'));
        return $service !== '' ? ['MessagingServiceSid' => $service] : [];
    }

    protected function toAddress(string $e164): string
    {
        return $e164;
    }

    protected function contentFields(NotifyMessage $m): array|NotifyResult
    {
        $text = NotifyProviderSupport::messageText($m, false);
        if ($text === '') return NotifyResult::rejected('the SMS is empty');
        return ['Body' => NotifyProviderSupport::truncate($text, 1600)];
    }
}
