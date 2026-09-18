import { useEffect, useState } from "react";
import { getJson } from "../../lib/payments";
import { formatMoney } from "../../lib/money";
import Button from "../ui/Button";
import Alert from "../ui/Alert";

export default function StreamDonations({ stream, lang, t }) {
  const [result, setResult] = useState({ loading: true, totals: [], error: false });
  const [attempt, setAttempt] = useState(0);
  const enabled = Boolean(stream.flags?.donations) && stream.status !== "CANCELLED";
  useEffect(() => {
    let cancelled = false;
    if (!enabled) return undefined;
    setResult({ loading: true, totals: [], error: false });
    getJson(`/api/live-streams/${encodeURIComponent(stream.slug)}/donations`).then((res) => {
      if (!cancelled) setResult({
        loading: false, error: !res.ok || !Array.isArray(res.body?.totals), totals: res.body?.totals ?? [],
      });
    });
    return () => { cancelled = true; };
  }, [stream.slug, enabled, attempt]);
  if (!enabled) return null;
  return <section className="live-about" aria-labelledby="live-donations-title">
    <h3 id="live-donations-title" className="live-about__title">{t("இந்த தரிசனத்திற்கான நன்கொடைகள்", "Donations for this darshan")}</h3>
    {result.loading ? <p role="status">{t("ஏற்றுகிறது…", "Loading…")}</p> : result.error ? <Alert tone="error">
      {t("நன்கொடை மொத்தம் இப்போது கிடைக்கவில்லை.", "Donation totals are unavailable.")}
      <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயல்க", "Try again")}</Button>
    </Alert> : result.totals.length ? <ul>
      {result.totals.map((total) => <li key={total.currency}>{formatMoney(total.amount, total.currency, lang)} · {total.count} {total.count === 1 ? t("நன்கொடை", "donation") : t("நன்கொடைகள்", "donations")}</li>)}
    </ul> : <p>{t("இதுவரை உறுதிப்படுத்தப்பட்ட நன்கொடைகள் இல்லை.", "No confirmed donations yet.")}</p>}
    <p className="live-stream__desc">{t("உண்மையான இணையவழிப் பணம் மட்டும்; திருப்பிய தொகை கழிக்கப்பட்டது.", "Real online payments only, after completed refunds. Test payments are excluded.")}</p>
  </section>;
}
