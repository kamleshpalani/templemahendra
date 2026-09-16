<?php
/**
 * backend/includes/payments/validate.php — what a donor may submit
 * (docs/payments/SPEC.md §5.2).
 *
 * Both validators return ['values' => normalised values, 'fields' => key =>
 * English sentence]. An empty fields array means the values can be stored. The
 * frontend shows its own bilingual copy per key; these sentences are for API
 * callers and logs. Hostile input (arrays where text is expected, huge strings,
 * invalid UTF-8) becomes a field error, never an exception.
 *
 * Amounts and prices always come from here or the database, never from the
 * request at payment time.
 */

/**
 * ISO-2 => [English name, dial code, min national digits, max national digits],
 * generated from frontend/src/data/countries.js (245 entries) so the server's
 * phone rules match the form's. Regenerate after editing that file.
 */
function payCountryTable(): array
{
    static $table = null;
    return $table ??= [
        'AF' => ['Afghanistan', '93', 9, 9],
        'AX' => ['Aland Islands', '358', 6, 12],
        'AL' => ['Albania', '355', 8, 9],
        'DZ' => ['Algeria', '213', 8, 9],
        'AS' => ['American Samoa', '1', 10, 10],
        'AD' => ['Andorra', '376', 6, 6],
        'AO' => ['Angola', '244', 9, 9],
        'AI' => ['Anguilla', '1', 10, 10],
        'AG' => ['Antigua and Barbuda', '1', 10, 10],
        'AR' => ['Argentina', '54', 10, 11],
        'AM' => ['Armenia', '374', 8, 8],
        'AW' => ['Aruba', '297', 7, 7],
        'AC' => ['Ascension Island', '247', 4, 5],
        'AU' => ['Australia', '61', 9, 9],
        'AT' => ['Austria', '43', 6, 13],
        'AZ' => ['Azerbaijan', '994', 9, 9],
        'BS' => ['Bahamas', '1', 10, 10],
        'BH' => ['Bahrain', '973', 8, 8],
        'BD' => ['Bangladesh', '880', 7, 10],
        'BB' => ['Barbados', '1', 10, 10],
        'BY' => ['Belarus', '375', 9, 9],
        'BE' => ['Belgium', '32', 8, 9],
        'BZ' => ['Belize', '501', 7, 7],
        'BJ' => ['Benin', '229', 8, 10],
        'BM' => ['Bermuda', '1', 10, 10],
        'BT' => ['Bhutan', '975', 7, 8],
        'BO' => ['Bolivia', '591', 8, 8],
        'BA' => ['Bosnia and Herzegovina', '387', 8, 9],
        'BW' => ['Botswana', '267', 7, 8],
        'BR' => ['Brazil', '55', 10, 11],
        'IO' => ['British Indian Ocean Territory', '246', 7, 7],
        'VG' => ['British Virgin Islands', '1', 10, 10],
        'BN' => ['Brunei', '673', 7, 7],
        'BG' => ['Bulgaria', '359', 8, 9],
        'BF' => ['Burkina Faso', '226', 8, 8],
        'BI' => ['Burundi', '257', 8, 8],
        'KH' => ['Cambodia', '855', 8, 9],
        'CM' => ['Cameroon', '237', 9, 9],
        'CA' => ['Canada', '1', 10, 10],
        'CV' => ['Cape Verde', '238', 7, 7],
        'BQ' => ['Caribbean Netherlands', '599', 7, 8],
        'KY' => ['Cayman Islands', '1', 10, 10],
        'CF' => ['Central African Republic', '236', 8, 8],
        'TD' => ['Chad', '235', 8, 8],
        'CL' => ['Chile', '56', 8, 9],
        'CN' => ['China', '86', 8, 11],
        'CX' => ['Christmas Island', '61', 9, 9],
        'CC' => ['Cocos (Keeling) Islands', '61', 9, 9],
        'CO' => ['Colombia', '57', 10, 10],
        'KM' => ['Comoros', '269', 7, 7],
        'CK' => ['Cook Islands', '682', 5, 7],
        'CR' => ['Costa Rica', '506', 8, 8],
        'HR' => ['Croatia', '385', 8, 9],
        'CU' => ['Cuba', '53', 6, 8],
        'CW' => ['Curacao', '599', 7, 8],
        'CY' => ['Cyprus', '357', 8, 8],
        'CZ' => ['Czechia', '420', 9, 9],
        'CD' => ['Democratic Republic of the Congo', '243', 7, 9],
        'DK' => ['Denmark', '45', 8, 8],
        'DJ' => ['Djibouti', '253', 8, 8],
        'DM' => ['Dominica', '1', 10, 10],
        'DO' => ['Dominican Republic', '1', 10, 10],
        'EC' => ['Ecuador', '593', 8, 9],
        'EG' => ['Egypt', '20', 8, 10],
        'SV' => ['El Salvador', '503', 8, 8],
        'GQ' => ['Equatorial Guinea', '240', 9, 9],
        'ER' => ['Eritrea', '291', 7, 7],
        'EE' => ['Estonia', '372', 7, 8],
        'SZ' => ['Eswatini', '268', 8, 8],
        'ET' => ['Ethiopia', '251', 9, 9],
        'FK' => ['Falkland Islands', '500', 5, 5],
        'FO' => ['Faroe Islands', '298', 6, 6],
        'FJ' => ['Fiji', '679', 7, 7],
        'FI' => ['Finland', '358', 6, 12],
        'FR' => ['France', '33', 9, 9],
        'GF' => ['French Guiana', '594', 9, 9],
        'PF' => ['French Polynesia', '689', 8, 8],
        'GA' => ['Gabon', '241', 7, 8],
        'GM' => ['Gambia', '220', 7, 7],
        'GE' => ['Georgia', '995', 9, 9],
        'DE' => ['Germany', '49', 6, 13],
        'GH' => ['Ghana', '233', 9, 9],
        'GI' => ['Gibraltar', '350', 8, 8],
        'GR' => ['Greece', '30', 10, 10],
        'GL' => ['Greenland', '299', 6, 6],
        'GD' => ['Grenada', '1', 10, 10],
        'GP' => ['Guadeloupe', '590', 9, 9],
        'GU' => ['Guam', '1', 10, 10],
        'GT' => ['Guatemala', '502', 8, 8],
        'GG' => ['Guernsey', '44', 10, 10],
        'GN' => ['Guinea', '224', 8, 9],
        'GW' => ['Guinea-Bissau', '245', 7, 9],
        'GY' => ['Guyana', '592', 7, 7],
        'HT' => ['Haiti', '509', 8, 8],
        'HN' => ['Honduras', '504', 8, 8],
        'HK' => ['Hong Kong', '852', 8, 8],
        'HU' => ['Hungary', '36', 8, 9],
        'IS' => ['Iceland', '354', 7, 7],
        'IN' => ['India', '91', 10, 10],
        'ID' => ['Indonesia', '62', 8, 12],
        'IR' => ['Iran', '98', 9, 10],
        'IQ' => ['Iraq', '964', 8, 10],
        'IE' => ['Ireland', '353', 7, 9],
        'IM' => ['Isle of Man', '44', 10, 10],
        'IL' => ['Israel', '972', 8, 9],
        'IT' => ['Italy', '39', 6, 11],
        'CI' => ['Ivory Coast', '225', 8, 10],
        'JM' => ['Jamaica', '1', 10, 10],
        'JP' => ['Japan', '81', 9, 10],
        'JE' => ['Jersey', '44', 10, 10],
        'JO' => ['Jordan', '962', 8, 9],
        'KZ' => ['Kazakhstan', '7', 10, 10],
        'KE' => ['Kenya', '254', 8, 9],
        'KI' => ['Kiribati', '686', 5, 8],
        'XK' => ['Kosovo', '383', 8, 9],
        'KW' => ['Kuwait', '965', 8, 8],
        'KG' => ['Kyrgyzstan', '996', 9, 9],
        'LA' => ['Laos', '856', 8, 10],
        'LV' => ['Latvia', '371', 8, 8],
        'LB' => ['Lebanon', '961', 7, 8],
        'LS' => ['Lesotho', '266', 8, 8],
        'LR' => ['Liberia', '231', 7, 9],
        'LY' => ['Libya', '218', 8, 9],
        'LI' => ['Liechtenstein', '423', 7, 7],
        'LT' => ['Lithuania', '370', 8, 8],
        'LU' => ['Luxembourg', '352', 6, 11],
        'MO' => ['Macau', '853', 8, 8],
        'MG' => ['Madagascar', '261', 9, 9],
        'MW' => ['Malawi', '265', 7, 9],
        'MY' => ['Malaysia', '60', 8, 10],
        'MV' => ['Maldives', '960', 7, 7],
        'ML' => ['Mali', '223', 8, 8],
        'MT' => ['Malta', '356', 8, 8],
        'MH' => ['Marshall Islands', '692', 7, 7],
        'MQ' => ['Martinique', '596', 9, 9],
        'MR' => ['Mauritania', '222', 8, 8],
        'MU' => ['Mauritius', '230', 7, 8],
        'YT' => ['Mayotte', '262', 9, 9],
        'MX' => ['Mexico', '52', 10, 10],
        'FM' => ['Micronesia', '691', 7, 7],
        'MD' => ['Moldova', '373', 8, 8],
        'MC' => ['Monaco', '377', 8, 9],
        'MN' => ['Mongolia', '976', 8, 8],
        'ME' => ['Montenegro', '382', 8, 8],
        'MS' => ['Montserrat', '1', 10, 10],
        'MA' => ['Morocco', '212', 9, 9],
        'MZ' => ['Mozambique', '258', 8, 9],
        'MM' => ['Myanmar', '95', 7, 10],
        'NA' => ['Namibia', '264', 7, 9],
        'NR' => ['Nauru', '674', 7, 7],
        'NP' => ['Nepal', '977', 8, 10],
        'NL' => ['Netherlands', '31', 9, 9],
        'NC' => ['New Caledonia', '687', 6, 6],
        'NZ' => ['New Zealand', '64', 8, 10],
        'NI' => ['Nicaragua', '505', 8, 8],
        'NE' => ['Niger', '227', 8, 8],
        'NG' => ['Nigeria', '234', 7, 10],
        'NU' => ['Niue', '683', 4, 7],
        'NF' => ['Norfolk Island', '672', 5, 6],
        'KP' => ['North Korea', '850', 6, 10],
        'MK' => ['North Macedonia', '389', 8, 8],
        'MP' => ['Northern Mariana Islands', '1', 10, 10],
        'NO' => ['Norway', '47', 8, 8],
        'OM' => ['Oman', '968', 8, 8],
        'PK' => ['Pakistan', '92', 9, 10],
        'PW' => ['Palau', '680', 7, 7],
        'PS' => ['Palestine', '970', 8, 9],
        'PA' => ['Panama', '507', 7, 8],
        'PG' => ['Papua New Guinea', '675', 7, 8],
        'PY' => ['Paraguay', '595', 8, 9],
        'PE' => ['Peru', '51', 8, 9],
        'PH' => ['Philippines', '63', 8, 10],
        'PN' => ['Pitcairn Islands', '64', 8, 10],
        'PL' => ['Poland', '48', 9, 9],
        'PT' => ['Portugal', '351', 9, 9],
        'PR' => ['Puerto Rico', '1', 10, 10],
        'QA' => ['Qatar', '974', 8, 8],
        'CG' => ['Republic of the Congo', '242', 9, 9],
        'RE' => ['Réunion', '262', 9, 9],
        'RO' => ['Romania', '40', 9, 9],
        'RU' => ['Russia', '7', 10, 10],
        'RW' => ['Rwanda', '250', 9, 9],
        'BL' => ['Saint Barthelemy', '590', 9, 9],
        'SH' => ['Saint Helena', '290', 4, 5],
        'KN' => ['Saint Kitts and Nevis', '1', 10, 10],
        'LC' => ['Saint Lucia', '1', 10, 10],
        'MF' => ['Saint Martin', '590', 9, 9],
        'PM' => ['Saint Pierre and Miquelon', '508', 6, 6],
        'VC' => ['Saint Vincent and the Grenadines', '1', 10, 10],
        'WS' => ['Samoa', '685', 5, 7],
        'SM' => ['San Marino', '378', 6, 10],
        'ST' => ['Sao Tome and Principe', '239', 7, 7],
        'SA' => ['Saudi Arabia', '966', 8, 9],
        'SN' => ['Senegal', '221', 9, 9],
        'RS' => ['Serbia', '381', 8, 10],
        'SC' => ['Seychelles', '248', 7, 7],
        'SL' => ['Sierra Leone', '232', 8, 8],
        'SG' => ['Singapore', '65', 8, 8],
        'SX' => ['Sint Maarten', '1', 10, 10],
        'SK' => ['Slovakia', '421', 9, 9],
        'SI' => ['Slovenia', '386', 8, 8],
        'SB' => ['Solomon Islands', '677', 5, 7],
        'SO' => ['Somalia', '252', 7, 9],
        'ZA' => ['South Africa', '27', 9, 9],
        'KR' => ['South Korea', '82', 8, 10],
        'SS' => ['South Sudan', '211', 9, 9],
        'ES' => ['Spain', '34', 9, 9],
        'LK' => ['Sri Lanka', '94', 9, 9],
        'SD' => ['Sudan', '249', 8, 9],
        'SR' => ['Suriname', '597', 6, 7],
        'SJ' => ['Svalbard and Jan Mayen', '47', 8, 8],
        'SE' => ['Sweden', '46', 7, 10],
        'CH' => ['Switzerland', '41', 9, 9],
        'SY' => ['Syria', '963', 8, 9],
        'TW' => ['Taiwan', '886', 8, 9],
        'TJ' => ['Tajikistan', '992', 9, 9],
        'TZ' => ['Tanzania', '255', 9, 9],
        'TH' => ['Thailand', '66', 8, 9],
        'TL' => ['Timor-Leste', '670', 7, 8],
        'TG' => ['Togo', '228', 8, 8],
        'TK' => ['Tokelau', '690', 4, 5],
        'TO' => ['Tonga', '676', 5, 7],
        'TT' => ['Trinidad and Tobago', '1', 10, 10],
        'TN' => ['Tunisia', '216', 8, 8],
        'TR' => ['Turkey', '90', 10, 10],
        'TM' => ['Turkmenistan', '993', 8, 8],
        'TC' => ['Turks and Caicos Islands', '1', 10, 10],
        'TV' => ['Tuvalu', '688', 5, 7],
        'UG' => ['Uganda', '256', 9, 9],
        'UA' => ['Ukraine', '380', 9, 9],
        'AE' => ['United Arab Emirates', '971', 8, 9],
        'GB' => ['United Kingdom', '44', 9, 10],
        'US' => ['United States', '1', 10, 10],
        'UY' => ['Uruguay', '598', 8, 8],
        'VI' => ['US Virgin Islands', '1', 10, 10],
        'UZ' => ['Uzbekistan', '998', 9, 9],
        'VU' => ['Vanuatu', '678', 5, 7],
        'VA' => ['Vatican City', '39', 6, 11],
        'VE' => ['Venezuela', '58', 10, 10],
        'VN' => ['Vietnam', '84', 9, 10],
        'WF' => ['Wallis and Futuna', '681', 6, 6],
        'EH' => ['Western Sahara', '212', 9, 9],
        'YE' => ['Yemen', '967', 7, 9],
        'ZM' => ['Zambia', '260', 9, 9],
        'ZW' => ['Zimbabwe', '263', 7, 9],
    ];
}

/** A text field: the string, '' when absent/null, or null when it is not text (array, object, bool). */
function payFieldText(array $body, string $key): ?string
{
    if (!array_key_exists($key, $body) || $body[$key] === null) return '';
    $v = $body[$key];
    if (is_string($v)) return mb_check_encoding($v, 'UTF-8') ? $v : null;
    if (is_int($v) || is_float($v)) return (string) $v;
    return null;
}

/**
 * An optional free-text field, trimmed. Adds a field error for wrong types,
 * over-long text or control characters. Returns the value or null when empty.
 */
function payOptionalText(array $body, string $key, int $max, array &$fields, string $label, bool $multiline = false): ?string
{
    $v = payFieldText($body, $key);
    if ($v === null) {
        $fields[$key] = "Enter {$label} as text.";
        return null;
    }
    $v = trim($v);
    if ($v === '') return null;
    if (mb_strlen($v) > $max) {
        $fields[$key] = "Please keep {$label} to {$max} characters.";
        return null;
    }
    $bad = $multiline ? '/[\x{0}-\x{8}\x{B}\x{C}\x{E}-\x{1F}\x{7F}]/u' : '/\p{Cc}/u';
    if (preg_match($bad, $v)) {
        $fields[$key] = ucfirst($label) . ' contains characters that cannot be used.';
        return null;
    }
    return $v;
}

/** '' when a person's name is acceptable (2–100 characters after trimming, no control characters). */
function payNameProblem(string $name): string
{
    $len = mb_strlen($name);
    if ($len < 2) return 'Please enter your full name.';
    if ($len > 100) return 'Please keep the name to 100 characters.';
    if (preg_match('/\p{Cc}/u', $name)) return 'The name contains characters that cannot be used.';
    return '';
}

/**
 * A phone number and its country checked as the form checks them:
 * normalizePhone() (7–15 digits), then the country's dial code and national
 * length from payCountryTable(). $phone is the E.164 digits the form sends
 * (dial code + national number).
 *
 * @return array{phone:string, country:?string, error:string, field:string}
 */
function payPhoneCheck(mixed $phone, mixed $country): array
{
    $iso = is_string($country) ? strtoupper(trim($country)) : '';
    if (!is_string($phone) && !is_int($phone)) {
        return ['phone' => '', 'country' => null, 'error' => 'Please enter a phone number.', 'field' => 'phone'];
    }
    $ph = normalizePhone((string) $phone, $iso, true);
    if ($ph['error'] !== '') return ['phone' => '', 'country' => null, 'error' => $ph['error'], 'field' => 'phone'];
    $table = payCountryTable();
    if (!isset($table[$iso])) {
        return ['phone' => '', 'country' => null, 'error' => 'Choose the country of this phone number.', 'field' => 'phoneCountry'];
    }
    [$name, $dial, $min, $max] = $table[$iso];
    if (!str_starts_with($ph['phone'], $dial)) {
        return ['phone' => '', 'country' => $iso, 'error' => "That number does not start with the +{$dial} code for {$name}.", 'field' => 'phone'];
    }
    $national = substr($ph['phone'], strlen($dial));
    if ($national !== '' && $national[0] === '0') {
        return ['phone' => '', 'country' => $iso, 'error' => 'Leave off the leading 0 — the country code replaces it.', 'field' => 'phone'];
    }
    $len = strlen($national);
    if ($len < $min) {
        $msg = $min === $max ? "A {$name} number has {$min} digits." : "A {$name} number has at least {$min} digits.";
        return ['phone' => '', 'country' => $iso, 'error' => $msg, 'field' => 'phone'];
    }
    if ($len > $max) {
        $msg = $min === $max ? "A {$name} number has {$max} digits." : "A {$name} number has at most {$max} digits.";
        return ['phone' => '', 'country' => $iso, 'error' => $msg, 'field' => 'phone'];
    }
    return ['phone' => $ph['phone'], 'country' => $iso, 'error' => '', 'field' => 'phone'];
}

/** An optional email: [normalised or null, problem]. */
function payEmailCheck(array $body, string $key = 'email'): array
{
    $v = payFieldText($body, $key);
    if ($v === null) return [null, 'Enter a valid email address, or leave it empty.'];
    $v = trim($v);
    if ($v === '') return [null, ''];
    if (strlen($v) > 190 || filter_var($v, FILTER_VALIDATE_EMAIL) === false) {
        return [null, 'Enter a valid email address, or leave it empty.'];
    }
    return [strtolower($v), ''];
}

/** True when a JSON value is an explicit yes (true, 1, "1", "true"). */
function payConsent(mixed $value): bool
{
    return publicGuardConsent($value);
}

/**
 * POST /api/payments/donations body. $cfg is payConfig().
 *
 * values: category (slug), category_id, category_name {ta,en}, amount ("1001.00"),
 * currency, name, phone (E.164 digits), phone_country, country, email, address,
 * city, state, postcode, pan, message, notes, show_name_publicly (bool), lang.
 *
 * @return array{values:array, fields:array<string,string>}
 */
function payValidateDonation(array $body, array $cfg): array
{
    $fields = [];
    $values = [];

    // Purpose
    $slug = payFieldText($body, 'category');
    $category = null;
    if ($slug === null || trim($slug) === '') {
        $fields['category'] = 'Choose what your donation is for.';
    } else {
        $category = payCategoryBySlug(getDB(), trim($slug), true);
        if ($category === null) $fields['category'] = 'Choose one of the donation purposes listed.';
    }

    // Currency
    $currency = payFieldText($body, 'currency');
    if ($currency === null) {
        $fields['currency'] = 'Choose a currency.';
        $currency = $cfg['default_currency'];
    } else {
        $currency = strtoupper(trim($currency));
        if ($currency === '') $currency = $cfg['default_currency'];
        if (!isset(PAY_SUPPORTED_CURRENCIES[$currency])) {
            $fields['currency'] = 'That currency is not accepted.';
        } elseif ($currency !== 'INR' && !$cfg['international']) {
            $fields['currency'] = 'Only Indian Rupees (INR) are accepted right now.';
        } elseif (!in_array($currency, $cfg['currencies'], true)) {
            $fields['currency'] = 'That currency is not accepted.';
        }
    }

    // Amount
    $rawAmount = $body['amount'] ?? null;
    $amount = payAmountParse($rawAmount);
    if ($rawAmount === null || $rawAmount === '') {
        $fields['amount'] = 'Enter the amount you would like to give.';
    } elseif ($amount === null) {
        $fields['amount'] = 'Enter the amount in figures, for example 1000 or 1000.50.';
    } elseif (!isset($fields['currency'])) {
        $cents = payAmountCents($amount);
        if ($currency === 'INR') {
            if ($cents < payAmountCents($cfg['donation_min'])) {
                $fields['amount'] = 'Enter an amount of at least ' . payMoneyLabel($cfg['donation_min'], 'INR') . '.';
            } elseif ($cents > payAmountCents($cfg['donation_max'])) {
                $fields['amount'] = 'The most that can be given online at one time is ' . payMoneyLabel($cfg['donation_max'], 'INR') . '.';
            }
        } else {
            if (payCurrencyDecimals($currency) === 0 && $cents % 100 !== 0) {
                $fields['amount'] = "Amounts in {$currency} must be whole numbers.";
            } elseif ($cents < 100) {
                $fields['amount'] = "Enter an amount of at least 1 {$currency}.";
            } elseif ($cents > payAmountCents($cfg['donation_max_foreign'])) {
                $fields['amount'] = 'The most that can be given online at one time is ' . intdiv(payAmountCents($cfg['donation_max_foreign']), 100) . " {$currency}.";
            }
        }
    }

    // Name
    $name = payFieldText($body, 'name');
    if ($name === null) {
        $fields['name'] = 'Please enter your full name.';
        $name = '';
    } else {
        $name = trim($name);
        $problem = payNameProblem($name);
        if ($problem !== '') $fields['name'] = $problem;
    }

    // Phone
    $ph = payPhoneCheck($body['phone'] ?? null, $body['phoneCountry'] ?? null);
    if ($ph['error'] !== '') $fields[$ph['field']] = $ph['error'];

    // Country
    $country = payFieldText($body, 'country');
    $country = $country === null ? '' : strtoupper(trim($country));
    if ($country === '' || !isset(payCountryTable()[$country])) {
        $fields['country'] = 'Choose your country.';
        $country = '';
    }

    [$email, $emailProblem] = payEmailCheck($body);
    if ($emailProblem !== '') $fields['email'] = $emailProblem;

    $address = payOptionalText($body, 'address', 250, $fields, 'the address');
    $city = payOptionalText($body, 'city', 120, $fields, 'the city');
    $state = payOptionalText($body, 'state', 120, $fields, 'the state');
    $postcode = payOptionalText($body, 'postcode', 15, $fields, 'the postal code');
    if ($postcode !== null) {
        if ($country === 'IN' && !preg_match('/^\d{6}$/D', $postcode)) {
            $fields['postcode'] = 'An Indian PIN code has 6 digits.';
        } elseif (!preg_match('/^[A-Za-z0-9][A-Za-z0-9 \-]{0,14}$/D', $postcode)) {
            $fields['postcode'] = 'Enter the postal code with letters, digits, spaces or hyphens only.';
        }
    }

    $pan = payFieldText($body, 'pan');
    if ($pan === null) {
        $fields['pan'] = 'Enter a PAN like ABCDE1234F, or leave it empty.';
        $pan = null;
    } else {
        $pan = strtoupper(preg_replace('/\s+/', '', $pan) ?? '');
        if ($pan === '') {
            $pan = null;
        } elseif (!preg_match('/^[A-Z]{5}[0-9]{4}[A-Z]$/D', $pan)) {
            $fields['pan'] = 'Enter a PAN like ABCDE1234F, or leave it empty.';
            $pan = null;
        }
    }

    $message = payOptionalText($body, 'message', 500, $fields, 'the message', true);
    $notes = payOptionalText($body, 'notes', 500, $fields, 'the note', true);

    if (!payConsent($body['acceptTerms'] ?? null)) {
        $fields['acceptTerms'] = 'Please accept the terms and refund policy.';
    }

    $values = [
        'category'           => $category['slug'] ?? null,
        'category_id'        => $category['id'] ?? null,
        'category_name'      => $category['name'] ?? null,
        'amount'             => $amount,
        'currency'           => $currency,
        'name'               => $name,
        'phone'              => $ph['phone'],
        'phone_country'      => $ph['country'],
        'country'            => $country !== '' ? $country : null,
        'email'              => $email,
        'address'            => $address,
        'city'               => $city,
        'state'              => $state,
        'postcode'           => $postcode,
        'pan'                => $pan,
        'message'            => $message,
        'notes'              => $notes,
        'show_name_publicly' => publicGuardConsent($body['showNamePublicly'] ?? null),
        'lang'               => devoteeLangFromInput($body['lang'] ?? null),
    ];
    return ['values' => $values, 'fields' => $fields];
}

/**
 * POST /api/payments/seva-bookings body. The price, seva name and currency
 * (INR) come from the sevas table; a posted amount is ignored.
 *
 * values: seva_id, seva {id, ta, en}, seva_name (in the booking language),
 * amount, currency, devotee_name, phone, phone_country, email, preferred_date,
 * message, lang.
 *
 * @return array{values:array, fields:array<string,string>}
 */
function payValidateSevaBooking(array $body, array $cfg): array
{
    $fields = [];
    $lang = devoteeLangFromInput($body['lang'] ?? null);

    $raw = $body['seva_id'] ?? null;
    $sevaId = is_int($raw) ? $raw : (is_string($raw) && preg_match('/^\d{1,9}$/D', trim($raw)) ? (int) trim($raw) : 0);
    $seva = null;
    if ($sevaId < 1) {
        $fields['seva_id'] = 'Choose a seva.';
    } else {
        $stmt = getDB()->prepare('SELECT id, name_ta, name_en, amount, is_active FROM sevas WHERE id = :id');
        $stmt->execute([':id' => $sevaId]);
        $seva = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        if ($seva === null || (int) $seva['is_active'] !== 1) {
            $fields['seva_id'] = 'That seva is not available for booking.';
            $seva = null;
        } elseif (payAmountCents((string) $seva['amount']) <= 0) {
            $fields['seva_id'] = 'This seva cannot be paid for online. Send a booking request instead.';
        } elseif (!$cfg['seva_online']) {
            $fields['seva_id'] = 'Paying for sevas online is not available right now.';
        }
    }

    $name = payFieldText($body, 'devotee_name');
    if ($name === null) {
        $fields['devotee_name'] = 'Please enter your full name.';
        $name = '';
    } else {
        $name = trim($name);
        $problem = payNameProblem($name);
        if ($problem !== '') $fields['devotee_name'] = $problem;
    }

    $ph = payPhoneCheck($body['phone'] ?? null, $body['phoneCountry'] ?? null);
    if ($ph['error'] !== '') $fields[$ph['field']] = $ph['error'];

    [$email, $emailProblem] = payEmailCheck($body);
    if ($emailProblem !== '') $fields['email'] = $emailProblem;

    $date = payFieldText($body, 'preferred_date');
    $preferred = null;
    if ($date === null) {
        $fields['preferred_date'] = 'Choose a date, or leave it empty.';
    } elseif (trim($date) !== '') {
        $date = trim($date);
        $today = payIstDate(null, 'Y-m-d');
        $last = (new DateTimeImmutable($today))->modify('+365 days')->format('Y-m-d');
        if (!isValidDate($date)) {
            $fields['preferred_date'] = 'Choose a real date.';
        } elseif ($date < $today) {
            $fields['preferred_date'] = 'Choose today or a later date.';
        } elseif ($date > $last) {
            $fields['preferred_date'] = 'Choose a date within the next year.';
        } else {
            $preferred = $date;
        }
    }

    $message = payOptionalText($body, 'message', 500, $fields, 'the message', true);

    if (!payConsent($body['acceptTerms'] ?? null)) {
        $fields['acceptTerms'] = 'Please accept the terms and refund policy.';
    }

    $sevaNames = $seva ? ['id' => (int) $seva['id'], 'ta' => trim((string) $seva['name_ta']), 'en' => trim((string) $seva['name_en'])] : null;
    $values = [
        'seva_id'        => $seva ? (int) $seva['id'] : null,
        'seva'           => $sevaNames,
        'seva_name'      => $sevaNames ? (($lang === 'ta' ? $sevaNames['ta'] : $sevaNames['en']) ?: ($sevaNames['en'] ?: $sevaNames['ta'])) : '',
        'amount'         => $seva ? payAmountFormat((string) $seva['amount'], 'INR') : null,
        'currency'       => 'INR',
        'devotee_name'   => $name,
        'phone'          => $ph['phone'],
        'phone_country'  => $ph['country'],
        'email'          => $email,
        'preferred_date' => $preferred,
        'message'        => $message,
        'lang'           => $lang,
    ];
    return ['values' => $values, 'fields' => $fields];
}
