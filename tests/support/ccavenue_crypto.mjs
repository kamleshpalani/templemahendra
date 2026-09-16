#!/usr/bin/env node
/**
 * tests/support/ccavenue_crypto.mjs — CCAvenue's wire encryption, written here
 * from the kit's description rather than from our PHP, so that the two can be
 * checked against each other (docs/payments/SPEC.md §4.3, §12).
 *
 *   AES-128-CBC, key = the raw MD5 of the working key, IV = 00 01 02 … 0f,
 *   PKCS#7 padding, hex on the wire (either case is accepted).
 *
 * Also the payload format the gateway and we both use: `key=value` pairs joined
 * with `&`, not URL-encoded.
 *
 * Run it on its own to check the pinned vector against this implementation:
 *
 *   node tests/support/ccavenue_crypto.mjs
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** CCAvenue's fixed initialisation vector. */
export const CCAV_IV = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

/**
 * The vector both sides pin: tests/payments-unit.php asserts PHP produces this
 * exact hex, and this file asserts the same when run directly.
 */
export const VECTOR = {
  plain: "merchant_id=1&order_id=A",
  key: "TESTKEY",
  hex: "9d13862a187313a737da15831e7a4a6bbf774a44c3e267524d82cd9847045fb2",
};

/** The 16-byte AES key CCAvenue derives from a working key. */
export function ccavKey(workingKey) {
  return crypto.createHash("md5").update(String(workingKey), "utf8").digest();
}

/** Hex ciphertext of `plain` under a working key. */
export function ccavEncrypt(plain, workingKey) {
  const cipher = crypto.createCipheriv("aes-128-cbc", ccavKey(workingKey), CCAV_IV);
  return Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]).toString("hex");
}

/**
 * The plain text of hex ciphertext, or null when it is empty, not hex, of odd
 * length, does not decrypt under this key or is not valid UTF-8 — the same
 * refusals as ccavDecrypt() in PHP.
 */
export function ccavDecrypt(hex, workingKey) {
  const text = String(hex ?? "").trim();
  if (text === "" || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) return null;
  const bytes = Buffer.from(text, "hex");
  if (bytes.length === 0 || bytes.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", ccavKey(workingKey), CCAV_IV);
    const out = Buffer.concat([decipher.update(bytes), decipher.final()]);
    const plain = out.toString("utf8");
    // Buffer.toString replaces invalid sequences; a round trip that changes the
    // bytes means this key did not produce that text.
    return Buffer.compare(Buffer.from(plain, "utf8"), out) === 0 ? plain : null;
  } catch {
    return null;
  }
}

/** `key=value` pairs joined with `&`, in the order given, with nothing encoded. */
export function ccavBuild(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? "" : v}`)
    .join("&");
}

/**
 * A payload taken apart the way PHP's ccavParseResponse() does it: split on &,
 * each pair on its first =, keys trimmed, a value URL-decoded only when it holds
 * a %XX sequence, last duplicate wins.
 */
export function ccavParse(plain) {
  const out = {};
  for (const pair of String(plain ?? "").split("&")) {
    if (pair === "") continue;
    const i = pair.indexOf("=");
    const key = (i === -1 ? pair : pair.slice(0, i)).trim();
    if (key === "") continue;
    let value = i === -1 ? "" : pair.slice(i + 1);
    if (/%[0-9A-Fa-f]{2}/.test(value)) {
      try {
        value = decodeURIComponent(value.replace(/\+/g, " "));
      } catch {
        /* keep the raw value, as urldecode() would */
      }
    }
    out[key] = value;
  }
  return out;
}

/** "14/09/2026 18:04:11" — the trans_date format CCAvenue sends. */
export function ccavTransDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/* ── Self-check ────────────────────────────────────────────────────────── */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const hex = ccavEncrypt(VECTOR.plain, VECTOR.key);
  const checks = [
    [hex === VECTOR.hex, `the pinned vector encrypts to ${VECTOR.hex}`, hex],
    [ccavDecrypt(hex, VECTOR.key) === VECTOR.plain, "it decrypts back to the same text"],
    [ccavDecrypt(hex.toUpperCase(), VECTOR.key) === VECTOR.plain, "upper-case hex is accepted"],
    [ccavDecrypt(hex, "WRONGKEY") === null, "a wrong key gives null"],
    [ccavDecrypt("zz11", VECTOR.key) === null, "text that is not hex gives null"],
    [ccavDecrypt(hex.slice(0, -1), VECTOR.key) === null, "an odd number of hex digits gives null"],
    [ccavDecrypt("", VECTOR.key) === null, "an empty string gives null"],
    [ccavParse("a=1&b=x=y&a=2&c=%41%42").a === "2", "a duplicate key: the last one wins"],
    [ccavParse("a=1&b=x=y").b === "x=y", "an = inside a value is kept"],
    [ccavParse("c=%41%42").c === "AB", "a percent-encoded value is decoded"],
    [ccavParse("d=100%").d === "100%", "a bare % is left alone"],
  ];
  let failed = 0;
  for (const [ok, label, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : `\n    ${detail}`}`);
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
