import { useLang } from "../context/LangContext";
import { COMMITTEE, TRUST } from "../data/temple";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import CommitteeGrid from "../components/CommitteeGrid/CommitteeGrid";
import TrustDetails from "../components/TrustDetails/TrustDetails";
import "./PageCommon.css";

export default function TrustCommittee() {
  const { t } = useLang();
  const title = t("அறக்கட்டளை & கமிட்டி", "Trust & Committee");
  return <>
    <Seo title={title} description={t(TRUST.name.ta, TRUST.name.en)} />
    <PageHero variant="about" title={title} lead={t(TRUST.name.ta, TRUST.name.en)}
      crumbs={[{ label: title }]} />
    <section className="section" aria-labelledby="committee">
      <div className="container">
        <h2 id="committee" className="section-title">{t(COMMITTEE.heading.ta, COMMITTEE.heading.en)}</h2>
        <CommitteeGrid showHeading={false} showInvite={false} showSignoff={false} />
      </div>
    </section>
    <section className="section section--alt" aria-labelledby="trust">
      <div className="container page-prose">
        <h2 id="trust">{t("தர்ம அறக்கட்டளை", "Dharma Trust")}</h2>
        <p>{t(TRUST.narrative.ta, TRUST.narrative.en)}</p>
        <TrustDetails variant="full" id="trust-details" />
      </div>
    </section>
  </>;
}
