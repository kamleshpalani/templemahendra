<?php
/**
 * backend/includes/notify/providers/NotifyTwilioWhatsAppProvider.php — WhatsApp
 * through Twilio.
 *
 *   TWILIO_WHATSAPP_FROM  the approved sender, "whatsapp:+14155238886"
 *
 * Messages the temple starts need an approved template. On Twilio a template
 * is a Content Template, identified by its Content SID ("HX" + 32 hex), which
 * goes in provider_template on the notification template; its {{1}}, {{2}}…
 * are filled from provider_params through ContentVariables. Without a template
 * the text is sent as Body, which WhatsApp only delivers inside the 24-hour
 * window after the devotee last wrote to the temple.
 */

final class NotifyTwilioWhatsAppProvider extends NotifyTwilioBase
{
    public function channel(): string { return 'whatsapp'; }

    protected function senderFields(): array
    {
        $from = trim(notifyEnv('TWILIO_WHATSAPP_FROM'));
        return preg_match('/^whatsapp:\+\d{7,15}$/', $from) ? ['From' => $from] : [];
    }

    protected function toAddress(string $e164): string
    {
        return 'whatsapp:' . $e164;
    }

    protected function contentFields(NotifyMessage $m): array|NotifyResult
    {
        $template = trim((string) $m->providerTemplate);
        if ($template !== '') {
            // A Meta template name left over from switching drivers would be sent
            // as nothing Twilio understands; saying so is kinder than a silent failure.
            if (!preg_match('/^HX[0-9a-fA-F]{32}$/', $template)) {
                return NotifyResult::rejected('Twilio WhatsApp templates are Content SIDs (HX followed by 32 characters), and the template names something else: set the Content SID on the template in the admin');
            }
            $fields = ['ContentSid' => $template];
            if ($m->templateParams !== []) {
                $variables = [];
                foreach (array_values($m->templateParams) as $i => $value) {
                    $variables[(string) ($i + 1)] = is_scalar($value) ? (string) $value : '';
                }
                $fields['ContentVariables'] = (string) json_encode($variables, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_FORCE_OBJECT);
            }
            return $fields;
        }

        $text = NotifyProviderSupport::messageText($m, true);
        if ($text === '') return NotifyResult::rejected('the WhatsApp message is empty');
        $fields = ['Body' => NotifyProviderSupport::truncate($text, 1600)];
        // Twilio fetches media itself, and only over https.
        $image = NotifyProviderSupport::httpsUrl($m->imageUrl);
        if ($image !== null) $fields['MediaUrl'] = $image;
        return $fields;
    }
}
