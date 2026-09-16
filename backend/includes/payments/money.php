<?php
/**
 * backend/includes/payments/money.php — amounts as exact decimal strings.
 *
 * Money never passes through a float on its way to the database or the gateway:
 * an amount is a normalised string with two decimals ("1001.00"), compared and
 * added as whole paise (payAmountCents). Amounts come from the server — the seva
 * price, or a donation amount validated against the settings — never from the
 * browser at payment time (SPEC §0.7).
 */

/** Decimal places a currency is written with. JPY has none; every other supported currency has two. */
function payCurrencyDecimals(string $currency): int
{
    return strtoupper(trim($currency)) === 'JPY' ? 0 : 2;
}

/**
 * A submitted amount as a normalised "1234.50" string, or null when it is not a
 * plain positive decimal: `^\d{1,10}(\.\d{1,2})?$` only — no sign, exponent,
 * commas, full-width digits or more than two decimals (SPEC §5.2). Integers and
 * floats from JSON are accepted when they print as such a number. Zero parses
 * ("0.00"); the minimum is the validator's job.
 */
function payAmountParse(mixed $value): ?string
{
    if (is_bool($value) || $value === null) return null;
    if (is_int($value)) {
        if ($value < 0) return null;
        $s = (string) $value;
    } elseif (is_float($value)) {
        if (!is_finite($value) || $value < 0) return null;
        $s = (string) $value; // shortest round-trip form: 1.5 → "1.5", 1e30 → "1.0E+30" (refused below)
    } elseif (is_string($value)) {
        $s = trim($value, " \t");
    } else {
        return null;
    }
    if (!preg_match('/^(\d{1,10})(?:\.(\d{1,2}))?$/D', $s, $m)) return null;
    $whole = ltrim($m[1], '0');
    return ($whole === '' ? '0' : $whole) . '.' . str_pad($m[2] ?? '', 2, '0');
}

/**
 * Whole paise (cents) of a decimal amount string from the database or
 * payAmountParse(). Extra decimals beyond two are cut, not rounded; anything
 * unreadable is 0.
 */
function payAmountCents(string|int|float|null $amount): int
{
    $s = trim((string) $amount);
    if (!preg_match('/^(-?)(\d+)(?:\.(\d*))?$/D', $s, $m)) return 0;
    $cents = (int) $m[2] * 100 + (int) substr(str_pad($m[3] ?? '', 2, '0'), 0, 2);
    return $m[1] === '-' ? -$cents : $cents;
}

/** "1234.50" from 123450 paise. */
function payCentsToAmount(int $cents): string
{
    $sign = $cents < 0 ? '-' : '';
    $cents = abs($cents);
    return sprintf('%s%d.%02d', $sign, intdiv($cents, 100), $cents % 100);
}

/**
 * The amount exactly as CCAvenue's `amount` field wants it: two decimals, dot,
 * no grouping ("1001.00"). JPY is whole units followed by ".00" (SPEC §4.3).
 */
function payAmountFormat(string $amount, string $currency): string
{
    $cents = payAmountCents($amount);
    if (payCurrencyDecimals($currency) === 0) {
        return intdiv($cents, 100) . '.00';
    }
    return payCentsToAmount($cents);
}

/**
 * Notification-safe money: "Rs. 1,001" or "Rs. 501.50" for INR (as
 * devoteeMoneyLabel), "USD 25.00" for other currencies and "JPY 3000" for
 * whole-unit currencies. No ₹ sign, which would turn an SMS into Unicode.
 */
function payMoneyLabel(string $amount, string $currency): string
{
    $currency = strtoupper(trim($currency)) ?: 'INR';
    $cents = payAmountCents($amount);
    if ($currency === 'INR') {
        $decimals = $cents % 100 !== 0 ? 2 : 0;
        return 'Rs. ' . number_format($cents / 100, $decimals);
    }
    if (payCurrencyDecimals($currency) === 0) {
        return $currency . ' ' . intdiv($cents, 100);
    }
    return $currency . ' ' . payCentsToAmount($cents);
}

/** A decimal string as a JSON number: 500 for "500.00", 1.5 for "1.50". */
function payNumberOut(string|int|float|null $amount): int|float
{
    $cents = payAmountCents($amount);
    return $cents % 100 === 0 ? intdiv($cents, 100) : $cents / 100;
}
