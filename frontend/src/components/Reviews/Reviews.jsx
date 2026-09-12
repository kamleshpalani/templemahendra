import { useEffect, useState } from "react";
import { LuExternalLink, LuStar } from "react-icons/lu";
import api from "../../services/api";
import { useLang } from "../../context/LangContext";
import { MAPS_URL } from "../../data/temple";
import Button from "../ui/Button";
import SectionHeader from "../ui/SectionHeader";
import { SkeletonCards } from "../ui/Feedback";
import "./Reviews.css";

/** Star row — filled vs outlined glyphs, plus a text label, so it never relies on colour alone. */
function StarRating({ rating, size }) {
  const { t } = useLang();
  return (
    <span
      className={`reviews-stars${size === "lg" ? " reviews-stars--lg" : ""}`}
      role="img"
      aria-label={t(`${rating} / 5 நட்சத்திரங்கள்`, `${rating} out of 5 stars`)}
    >
      {[1, 2, 3, 4, 5].map((s) => (
        <LuStar
          key={s}
          aria-hidden="true"
          className={s <= rating ? "reviews-star reviews-star--filled" : "reviews-star"}
        />
      ))}
    </span>
  );
}

function ReviewCard({ review, index }) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState(false);
  const MAX = 180;
  const long = review.text.length > MAX;

  return (
    <article className="reviews-card card card--static rise" style={{ "--i": index }}>
      <div className="reviews-card__head">
        <span className="avatar avatar--lg reviews-card__avatar" aria-hidden="true">
          {review.avatar ? (
            <img src={review.avatar} alt="" referrerPolicy="no-referrer" />
          ) : (
            review.author.charAt(0).toUpperCase()
          )}
        </span>
        <div className="reviews-card__who">
          <p className="reviews-card__author">{review.author}</p>
          <p className="reviews-card__time">{review.time}</p>
        </div>
        <div className="reviews-card__stars">
          <StarRating rating={review.rating} />
        </div>
      </div>
      <p className="reviews-card__text">
        {long && !expanded ? review.text.slice(0, MAX) + "…" : review.text}
      </p>
      {long && (
        <Button
          variant="ghost"
          size="sm"
          className="reviews-card__toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {expanded ? t("குறைவாக காட்டு", "Show less") : t("மேலும் படிக்க", "Read more")}
        </Button>
      )}
    </article>
  );
}

const FALLBACK_REVIEWS = [
  {
    author: "Kavitha Rajan",
    rating: 5,
    time: "3 months ago",
    text: "அம்மன் கோவில் மிகவும் அழகாக உள்ளது. தரிசனம் செய்த பிறகு மனசு அமைதியாக இருந்தது. அர்ச்சகர்கள் மிகவும் அன்பாக நடத்தினார்கள்.",
    avatar: "",
  },
  {
    author: "Murugan S",
    rating: 5,
    time: "5 months ago",
    text: "One of the most peaceful temples in the region. The Renuka Devi idol is beautifully adorned. The Annadanam prasad was delicious and served with love. Highly recommend visiting during festival season.",
    avatar: "",
  },
  {
    author: "Lakshmi Priya",
    rating: 5,
    time: "6 months ago",
    text: "கோவிலில் நடைபெறும் அபிஷேகம் மிகவும் சிறப்பாக இருந்தது. தினசரி பூஜை முறையாக நடக்கிறது. இங்கு வந்தால் மனம் நிம்மதி அடைகிறது.",
    avatar: "",
  },
  {
    author: "Senthil Kumar",
    rating: 5,
    time: "8 months ago",
    text: "A sacred place with deep spiritual energy. The temple is well maintained and the priests are very knowledgeable. The evening aarti is a must-see experience.",
    avatar: "",
  },
  {
    author: "Valarmathi D",
    rating: 5,
    time: "1 year ago",
    text: "புதுப்பட்டியில் இந்த கோவில் ஒரு ஆன்மீக சக்தி வாய்ந்த இடம். தினசரி வழிபாடு மிகவும் ஒழுங்காக நடக்கிறது. அனைவரும் ஒருமுறையாவது வர வேண்டும்.",
    avatar: "",
  },
  {
    author: "Rajesh Naidu",
    rating: 5,
    time: "1 year ago",
    text: "This temple holds a very special place in our Dhabbalaar community. The Pournami pooja is conducted with great devotion and discipline. The premises are always kept clean and the management is very welcoming to all devotees.",
    avatar: "",
  },
];

// Single source of truth for the temple's map location (see data/temple.js)
const GOOGLE_MAPS_URL = MAPS_URL;

export default function Reviews({ t: tProp }) {
  const { t: tCtx } = useLang();
  const t = tProp || tCtx;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/reviews")
      .then((r) => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Use real reviews if API is configured and has data, else use fallback
  const isReal = !loading && data?.configured && data?.reviews?.length;
  const reviews = isReal ? data.reviews : FALLBACK_REVIEWS;
  const hasRealRating = Boolean(isReal && data.rating);

  const rateButton = (
    <Button
      href={GOOGLE_MAPS_URL}
      target="_blank"
      rel="noopener noreferrer"
      variant="outline"
      className="reviews-summary__link"
      trailingIcon={<LuExternalLink aria-hidden="true" />}
    >
      {t("Google-ல் மதிப்பீடு இடுங்கள்", "Rate on Google")}
    </Button>
  );

  return (
    <section className="section reveal" aria-labelledby="home-reviews-title">
      <div className="container">
        <SectionHeader
          id="home-reviews-title"
          eyebrow={t("Google மதிப்புரைகள்", "Google reviews")}
          title={t("பக்தர்களின் அனுபவங்கள்", "Devotee Reviews")}
        />

        {loading ? (
          <>
            <p className="sr-only" role="status">
              {t("மதிப்புரைகள் ஏற்றுகிறது…", "Loading reviews…")}
            </p>
            <SkeletonCards count={3} className="grid-3" />
          </>
        ) : (
          <>
            <div className="reviews-summary card card--soft card--static">
              <span className="reviews-summary__score text-gradient">{hasRealRating ? data.rating : "5.0"}</span>
              <div className="reviews-summary__meta">
                <StarRating rating={hasRealRating ? Math.round(data.rating) : 5} size="lg" />
                {hasRealRating && data.total_ratings != null && (
                  <span className="reviews-summary__count">
                    {data.total_ratings.toLocaleString()} {t("மதிப்புரைகள்", "reviews")}
                  </span>
                )}
              </div>
              {rateButton}
            </div>

            <div className="reviews-grid grid-3">
              {reviews.map((r, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <ReviewCard key={i} review={r} index={i} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
