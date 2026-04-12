import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";
import "./Sevas.css";

export default function Sevas() {
  const [sevas, setSevas] = useState([]);
  const [loading, setLoading] = useState(true);
  const { lang, t } = useLang();

  useEffect(() => {
    api
      .get("/sevas")
      .then((r) => setSevas(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fallback = [
    {
      id: 1,
      name_ta: "அபிஷேகம்",
      name_en: "Abhishekam",
      amount: 251,
      description_ta: "பாலாபிஷேகம், தேன் மற்றும் ரோஜாநீரால் தெய்வ அபிஷேகம்.",
      description_en:
        "Sacred bathing of the deity with milk, honey, and rose water.",
    },
    {
      id: 2,
      name_ta: "அர்ச்சனை",
      name_en: "Archana",
      amount: 51,
      description_ta: "தெய்வத்தின் நாமங்களை ஓதி மலர் சமர்ப்பணம்.",
      description_en: "Offering of flowers with chanting of the deity's names.",
    },
    {
      id: 3,
      name_ta: "தீபாராதனை",
      name_en: "Deepa Aradhana",
      amount: 101,
      description_ta: "தெய்வத்திற்கு தீபாராதனை செய்தல்.",
      description_en: "Waving of sacred lamps before the deity.",
    },
    {
      id: 4,
      name_ta: "சகஸ்ர நாமம்",
      name_en: "Sahasranama",
      amount: 501,
      description_ta: "தெய்வத்தின் 1000 நாமங்களை சொல்லுதல்.",
      description_en: "Recitation of 1000 names of the deity.",
    },
    {
      id: 5,
      name_ta: "அன்னதானம்",
      name_en: "Annadanam",
      amount: 2001,
      description_ta: "பக்தர்களுக்கும் ஏழைகளுக்கும் இலவச உணவு வழங்குதல்.",
      description_en: "Sponsoring a free meal for devotees and the needy.",
    },
    {
      id: 6,
      name_ta: "வாகன பூஜை",
      name_en: "Vahana Pooja",
      amount: 1001,
      description_ta: "திருவிழா வாகனத்தில் சிறப்பு ஊர்வலம்.",
      description_en: "Ceremonial procession of the festival vehicle.",
    },
  ];

  const items = sevas.length > 0 ? sevas : fallback;

  return (
    <>
      <Helmet>
        <title>
          {t("சேவைகள்", "Sevas")} —{" "}
          {t(
            "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
            "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
          )}
        </title>
      </Helmet>

      <div className="page-hero page-hero--sevas">
        <div className="page-hero__content">
          <h1>{t("சேவைகள் & பூஜைகள்", "Sevas & Poojas")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <h2 className="section-title">
            {t("கிடைக்கும் சேவைகள்", "Available Sevas")}
          </h2>
          <div className="divider" />
          <p className="section-subtitle">
            {t(
              "எங்கள் கோயிலில் கிடைக்கும் சேவைகள் மற்றும் பூஜைகள்",
              "Sevas and poojas available at our temple",
            )}
          </p>

          {loading ? (
            <p className="loading-text">{t("ஏற்றுகிறது…", "Loading…")}</p>
          ) : (
            <div className="seva-list">
              {items.map((s) => (
                <div key={s.id} className="seva-row card">
                  <div className="seva-row__info">
                    <h3 className="seva-row__name-ta">
                      {lang === "ta" ? s.name_ta : s.name_en}
                    </h3>
                    {s.description_ta || s.description ? (
                      <p className="seva-row__desc">
                        {lang === "ta"
                          ? (s.description_ta ?? s.description)
                          : (s.description_en ?? s.description)}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="seva-note">
            <p>
              {t(
                "சேவை பதிவு செய்ய +91 00000 00000 என்ற எண்ணில் அழைக்கவும் அல்லது காலை 8 – 12 மணி, மாலை 4 – 8 மணி நேரத்தில் கோயில் அலுவலகத்தை நேரில் அணுகவும்.",
                "To book a seva, call us at +91 00000 00000 or visit the temple office between 8 AM – 12 PM and 4 PM – 8 PM.",
              )}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
