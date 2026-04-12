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
    text: "This temple holds a very special place in our Kammavar Naidu community. The Pournami pooja is conducted with great devotion and discipline. The premises are always kept clean and the management is very welcoming to all devotees.",
    avatar: "",
  },
];

const GOOGLE_MAPS_URL =
  "https://maps.google.com/maps?q=Dhabbalavaar+Renuka+Devi+Lingamma+Sinnammal+Temple,+Middle+Street,+Pudupatti,+Tamil+Nadu+627719";

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
            {isReal && data.rating ? (
              <div className="reviews-summary">
                <span className="reviews-summary__score">{data.rating}</span>
                <StarRating rating={Math.round(data.rating)} />
                <span className="reviews-summary__count">
                  {data.total_ratings.toLocaleString()}{" "}
                  {t("மதிப்புரைகள்", "reviews")}
                </span>
                <a
                  href={GOOGLE_MAPS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="reviews-summary__link"
                >
                  {t("Google-ல் மதிப்பீடு இடுங்கள்", "Rate on Google")} ↗
                </a>
              </div>
            ) : (
              <div className="reviews-summary">
                <span className="reviews-summary__score">5.0</span>
                <StarRating rating={5} />
                <a
                  href={GOOGLE_MAPS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="reviews-summary__link"
                >
                  {t("Google-ல் மதிப்பீடு இடுங்கள்", "Rate on Google")} ↗
                </a>
              </div>
            )}

            <div className="reviews-grid">
              {reviews.map((r, i) => (
                <ReviewCard key={i} review={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
