import { Helmet } from "react-helmet-async";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";

export default function About() {
  const { t } = useLang();

  return (
    <>
      <Helmet>
        <title>
          {t("பற்றி", "About")} —{" "}
          {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
        </title>
      </Helmet>

      <div className="page-hero page-hero--about">
        <div className="page-hero__content">
          <h1>{t("ஆலயம் பற்றி", "About the Temple")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container page-prose">
          <h2>{t("வரலாறு", "History")}</h2>
          <p>
            {t(
              "ஸ்ரீ மகேந்திர ஆலயம் பல தலைமுறைகளாக பக்தி, கலாச்சாரம் மற்றும் தமிழ் மரபின் மையமாகத் திகழ்கிறது. இங்குள்ள தலைமை தெய்வம் ஆகம மரபுப்படி தினமும் வழிபடப்படுகிறது.",
              "Sri Mahendra Temple has served the community for generations as a centre of devotion, culture, and Tamil tradition. The main deity enshrined here is worshipped daily with the full Agama tradition.",
            )}
          </p>

          <h2>{t("தெய்வம்", "Presiding Deity")}</h2>
          <p>
            {t(
              "இத்தலத்தின் தலைமை தெய்வம் திருவனந்தல், காலசந்தி, உச்சிகால, சாயரக்‍ஷை மற்றும் அர்த்தஜாம பூஜை உள்ளிட்ட விரிவான நாளாந்த சடங்குகளுடன் வழிபடப்படுகிறது.",
              "The presiding deity of the temple is worshipped with elaborate daily rituals including Thiruvanandal, Kaalaasanthi, Uchikalam, Sayarakshai, and Arthajama Pooja.",
            )}
          </p>

          <h2>{t("நிர்வாகம்", "Management")}</h2>
          <p>
            {t(
              "கோயில் ஒரு அறக்கட்டளைக் குழுவால் நிர்வகிக்கப்படுகிறது. அனைத்து கணக்குகளும் ஆண்டுதோறும் தணிக்கை செய்யப்பட்டு சமூகத்திடம் வெளியிடப்படுகின்றன.",
              "The temple is managed by a trust committee comprising trustees, executive members, and the principal priest. All accounts are audited annually and made available to the community.",
            )}
          </p>

          <h2>{t("வழிபாட்டு நேரங்கள்", "Timings")}</h2>
          <table className="timings-table">
            <thead>
              <tr>
                <th>{t("பூஜை", "Pooja")}</th>
                <th>{t("தமிழ்", "Tamil")}</th>
                <th>{t("நேரம்", "Time")}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Thiruvanandal", "திருவனந்தல்", "6:00 AM"],
                ["Kaalaasanthi", "காலசந்தி", "8:00 AM"],
                ["Uchikalam", "உச்சிகால பூஜை", "12:00 PM"],
                ["Sayarakshai", "சாயரக்‍ஷை", "6:00 PM"],
                ["Arthajama Pooja", "அர்த்தஜாம பூஜை", "8:30 PM"],
              ].map(([en, ta, time]) => (
                <tr key={en}>
                  <td>{t(ta, en)}</td>
                  <td>{ta}</td>
                  <td>{time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
