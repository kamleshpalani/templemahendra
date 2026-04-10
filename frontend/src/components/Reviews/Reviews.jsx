import { useEffect, useState } from "react";
import api from "../../services/api";
import { useLang } from "../../context/LangContext";
import "./Reviews.css";

function StarRating({ rating }) {
  return (
    <span className="review-stars" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <span key={s} className={s <= rating ? "star star--filled" : "star"}>
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({ review }) {
  const [expanded, setExpanded] = useState(false);
  const MAX = 180;
  const long = review.text.length > MAX;

  return (
    <div className="review-card card">
      <div className="review-card__header">
        {review.avatar ? (
          <img
            src={review.avatar}
            alt={review.author}
            className="review-card__avatar"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="review-card__avatar review-card__avatar--fallback">
            {review.author.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="review-card__author">{review.author}</p>
          <p className="review-card__time">{review.time}</p>
        </div>
        <div className="review-card__stars">
          <StarRating rating={review.rating} />
        </div>
      </div>
      <p className="review-card__text">
        {long && !expanded ? review.text.slice(0, MAX) + "…" : review.text}
      </p>
      {long && (
        <button
          className="review-card__toggle"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

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

  // If not configured or no reviews, render nothing
  if (!loading && (!data?.configured || !data?.reviews?.length)) return null;

  return (
    <section className="section section--reviews">
      <div className="container">
        <h2 className="section__title">
          {t("பக்தர்களின் அனுபவங்கள்", "Devotee Reviews")}
        </h2>

        {loading ? (
          <p className="loading-text">
            {t("மதிப்புரைகள் ஏற்றுகிறது…", "Loading reviews…")}
          </p>
        ) : (
          <>
            {data.rating && (
              <div className="reviews-summary">
                <span className="reviews-summary__score">{data.rating}</span>
                <StarRating rating={Math.round(data.rating)} />
                <span className="reviews-summary__count">
                  {data.total_ratings.toLocaleString()}{" "}
                  {t("மதிப்புரைகள்", "reviews")}
                </span>
                <a
                  href="https://maps.google.com/maps?q=Dhabbalavaar+Renuka+Devi+Lingamma+Sinnammal+Temple,+Middle+Street,+Pudupatti,+Tamil+Nadu+627719"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="reviews-summary__link"
                >
                  {t("Google-ல் மதிப்பீடு இடுங்கள்", "Rate on Google")} ↗
                </a>
              </div>
            )}

            <div className="reviews-grid">
              {data.reviews.map((r, i) => (
                <ReviewCard key={i} review={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
