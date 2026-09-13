import { useEffect, useState } from "react";
import { LuExternalLink, LuStar } from "react-icons/lu";
import api from "../../services/api";
import { useLang } from "../../context/LangContext";
import { MAPS_URL } from "../../data/temple";
import Button from "../ui/Button";
import SectionHeader from "../ui/SectionHeader";
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
          {review.time && <p className="reviews-card__time">{review.time}</p>}
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

/*
 * Only what Google actually returned is shown. Without a configured Places key,
 * with no reviews, while loading or after an error, the section renders nothing
 * at all: a heading over invented praise, or over an empty box, would misstate
 * what devotees have said about the temple.
 */
function usableReviews(data) {
  if (!data?.configured || !Array.isArray(data.reviews)) return [];
  return data.reviews
    .filter((r) => r && typeof r.author === "string" && r.author.trim() && typeof r.text === "string" && r.text.trim())
    .map((r) => ({
      ...r,
      rating: Math.min(5, Math.max(1, Math.round(Number(r.rating) || 5))),
    }));
}

export default function Reviews() {
  const { t } = useLang();
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .get("/reviews")
      .then((r) => {
        if (alive) setData(r.data);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reviews = usableReviews(data);
  if (reviews.length === 0) return null;

  const rating = Number(data.rating);
  const hasRating = Number.isFinite(rating) && rating > 0;
  const total = Number(data.total_ratings);

  return (
    <section className="section home-section reveal" aria-labelledby="home-reviews-title">
      <div className="container">
        <SectionHeader
          id="home-reviews-title"
          eyebrow={t("Google மதிப்புரைகள்", "Google reviews")}
          title={t("பக்தர்களின் அனுபவங்கள்", "Devotee Reviews")}
        />

        <div className="reviews-summary card card--soft card--static">
          {hasRating && (
            <>
              <span className="reviews-summary__score text-gradient">{rating.toFixed(1)}</span>
              <div className="reviews-summary__meta">
                <StarRating rating={Math.round(rating)} size="lg" />
                {total > 0 && (
                  <span className="reviews-summary__count">
                    {total.toLocaleString()} {t("மதிப்புரைகள்", "reviews")}
                  </span>
                )}
              </div>
            </>
          )}
          <Button
            href={MAPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="outline"
            className="reviews-summary__link"
            trailingIcon={<LuExternalLink aria-hidden="true" />}
          >
            {t("Google-ல் மதிப்பீடு இடுங்கள்", "Rate on Google")}
          </Button>
        </div>

        <div className="reviews-grid grid-3">
          {reviews.map((r, i) => (
            <ReviewCard key={`${r.timestamp ?? ""}-${r.author}-${i}`} review={r} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}
