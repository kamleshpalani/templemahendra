<?php
/**
 * backend/includes/notify/providers/NotifyEcKeys.php — P-256 keys with nothing
 * but PHP's openssl extension, for Web Push (VAPID signing and RFC 8291 payload
 * encryption) and the key helper CLI.
 *
 * Keys travel the way the Web Push world writes them: base64url of the raw
 * 65-byte uncompressed public point (0x04 || X || Y) and of the raw 32-byte
 * private scalar. openssl wants PEM, so the two DER wrappers are built by hand.
 * They are fixed-shape for P-256, which is why a few constant byte strings are
 * enough and no ASN.1 library is needed.
 *
 * WHY THE CONFIG DANCE. openssl_pkey_new() reads an openssl.cnf. Linux hosting
 * ships one at the path OpenSSL was compiled with, so the first attempt, with
 * no options, simply works there. The Windows PHP builds look for
 * "C:\Program Files\Common Files\SSL\openssl.cnf", which usually does not
 * exist, and key generation fails with "no such file". We then try the file
 * named by OPENSSL_CONF, and finally a four-line config written to the system
 * temp directory. Only generation needs this; loading hand-built keys does not.
 */

final class NotifyEcKeys
{
    /** DER prefix of a P-256 SubjectPublicKeyInfo; the 65-byte point follows. */
    private const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    /** The config options that worked last time, so later calls skip the failures. */
    private static ?array $workingOptions = null;

    /**
     * A fresh key pair: ['key' => OpenSSLAsymmetricKey, 'public' => 65 raw bytes,
     * 'private' => 32 raw bytes], or null when openssl cannot generate one.
     */
    public static function generate(): ?array
    {
        $base = ['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'];
        $attempts = self::$workingOptions !== null ? [self::$workingOptions] : self::configAttempts();

        foreach ($attempts as $options) {
            $key = @openssl_pkey_new($base + $options);
            self::clearErrors();
            if ($key === false) continue;
            $details = openssl_pkey_get_details($key);
            if (!is_array($details) || !isset($details['ec']['x'], $details['ec']['y'], $details['ec']['d'])) continue;
            self::$workingOptions = $options;
            return [
                'key'     => $key,
                'public'  => "\x04" . self::pad($details['ec']['x']) . self::pad($details['ec']['y']),
                'private' => self::pad($details['ec']['d']),
            ];
        }
        return null;
    }

    /** True for a raw uncompressed P-256 public point. Shape only; openssl checks the curve. */
    public static function isPublicPoint(string $raw): bool
    {
        return strlen($raw) === 65 && $raw[0] === "\x04";
    }

    public static function publicKey(string $raw65): ?OpenSSLAsymmetricKey
    {
        if (!self::isPublicPoint($raw65)) return null;
        $pem = "-----BEGIN PUBLIC KEY-----\n"
             . chunk_split(base64_encode(hex2bin(self::SPKI_PREFIX) . $raw65), 64, "\n")
             . "-----END PUBLIC KEY-----\n";
        $key = openssl_pkey_get_public($pem);
        self::clearErrors();
        return $key === false ? null : $key;
    }

    /**
     * A private key from the raw scalar, as SEC1 ECPrivateKey:
     *   SEQUENCE { INTEGER 1, OCTET STRING d, [0] OID prime256v1, [1] BIT STRING point }
     * The public point is optional; when it is left out OpenSSL computes it.
     */
    public static function privateKey(string $raw32, ?string $public65 = null): ?OpenSSLAsymmetricKey
    {
        if (strlen($raw32) !== 32) return null;
        $body = "\x02\x01\x01" . "\x04\x20" . $raw32 . "\xa0\x0a\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07";
        if ($public65 !== null) {
            if (!self::isPublicPoint($public65)) return null;
            $body .= "\xa1\x44\x03\x42\x00" . $public65;
        }
        $der = "\x30" . chr(strlen($body)) . $body;
        $pem = "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
        $key = openssl_pkey_get_private($pem);
        self::clearErrors();
        return $key === false ? null : $key;
    }

    /** The public point that belongs to a private scalar, to check a configured pair matches. */
    public static function publicFromPrivate(string $raw32): ?string
    {
        $key = self::privateKey($raw32);
        if ($key === null) return null;
        $details = openssl_pkey_get_details($key);
        if (!is_array($details) || !isset($details['ec']['x'], $details['ec']['y'])) return null;
        return "\x04" . self::pad($details['ec']['x']) . self::pad($details['ec']['y']);
    }

    /** ECDH: the 32-byte shared secret between our private key and a peer's public point. */
    public static function sharedSecret(OpenSSLAsymmetricKey $private, string $peerPublic65): ?string
    {
        $peer = self::publicKey($peerPublic65);
        if ($peer === null) return null;
        $secret = openssl_pkey_derive($peer, $private, 0);
        self::clearErrors();
        return is_string($secret) && strlen($secret) === 32 ? $secret : null;
    }

    /** ES256: sign and return the raw 64-byte R || S that JOSE requires (openssl gives DER). */
    public static function signEs256(string $data, OpenSSLAsymmetricKey $private): ?string
    {
        $der = '';
        $ok = openssl_sign($data, $der, $private, OPENSSL_ALGO_SHA256);
        self::clearErrors();
        return $ok ? self::derSignatureToRaw($der) : null;
    }

    /**
     * DER ECDSA signature → raw R || S, each left-padded to 32 bytes.
     *   SEQUENCE { INTEGER r, INTEGER s }
     * DER integers are minimal and signed, so r and s may carry a leading 0x00
     * (when the top bit is set) or be shorter than 32 bytes (leading zeros).
     */
    public static function derSignatureToRaw(string $der, int $partLength = 32): ?string
    {
        $len = strlen($der);
        if ($len < 8 || $der[0] !== "\x30") return null;
        $pos = 2;
        if (ord($der[1]) & 0x80) $pos = 2 + (ord($der[1]) & 0x7f);
        $raw = '';
        for ($i = 0; $i < 2; $i++) {
            if ($pos + 2 > $len || $der[$pos] !== "\x02") return null;
            $intLength = ord($der[$pos + 1]);
            $pos += 2;
            if ($pos + $intLength > $len) return null;
            $int = ltrim(substr($der, $pos, $intLength), "\x00");
            $pos += $intLength;
            if (strlen($int) > $partLength) return null;
            $raw .= str_pad($int, $partLength, "\x00", STR_PAD_LEFT);
        }
        return $raw;
    }

    private static function pad(string $bytes): string
    {
        return str_pad($bytes, 32, "\x00", STR_PAD_LEFT);
    }

    /** openssl keeps a per-process error queue; stale entries would be misattributed later. */
    private static function clearErrors(): void
    {
        while (openssl_error_string() !== false) {
            // drain
        }
    }

    /**
     * The option sets to try, in order: none, OPENSSL_CONF, the openssl.cnf the
     * Windows PHP zip ships beside php.exe (extras/ssl), a minimal temporary config.
     */
    private static function configAttempts(): array
    {
        $attempts = [[]];
        $env = (string) getenv('OPENSSL_CONF');
        if ($env !== '' && is_file($env)) $attempts[] = ['config' => $env];
        $shipped = dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'extras' . DIRECTORY_SEPARATOR . 'ssl' . DIRECTORY_SEPARATOR . 'openssl.cnf';
        if (PHP_BINARY !== '' && $shipped !== $env && is_file($shipped)) $attempts[] = ['config' => $shipped];

        $minimal = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'temple-notify-openssl.cnf';
        if (!is_file($minimal)) {
            // default_bits keeps PHP's key-length sanity check happy even for EC keys;
            // the [req] section is what openssl_pkey_new() looks up.
            @file_put_contents($minimal, "HOME = .\n[ req ]\ndefault_bits = 2048\ndistinguished_name = req_dn\n[ req_dn ]\n", LOCK_EX);
        }
        if (is_file($minimal)) $attempts[] = ['config' => $minimal];
        return $attempts;
    }
}
