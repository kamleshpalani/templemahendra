import { useId } from "react";
import { useLang } from "../../context/LangContext";
import {
  COMMITTEE,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  formatPhone,
  telHref,
} from "../../data/temple";
import "./CommitteeGrid.css";

/**
 * CommitteeGrid — the temple committee office-bearers as tap-to-call cards.
 * Every fact (names, roles, phones, heading, invite, sign-off) comes from
 * src/data/temple.js; nothing is hardcoded here.
 *
 * Props:
 *   id            — id on the root element (e.g. "committee" for #committee anchors)
 *   showHeading   — render the component's own heading (default true)
 *   showInvite    — render the "With warm regards, The Temple Committee" line (default true)
 *   showSignoff   — render the temple sign-off line under the grid (default true)
 *   headingLevel  — 2 (default: h2.section-title + .divider, centred section layout)
 *                   or 3 (nested inside a page that already has its own h2:
 *                   h3 heading, left-aligned, no divider). Card titles are h3,
 *                   except h4 when the component renders its own h3 heading;
 *                   with showHeading={false} the page supplies an h2, so cards
 *                   stay h3 and the outline never skips a level.
 *
 * The page supplies .section / .container; this component does not.
 */
export default function CommitteeGrid({
  id,
  showHeading = true,
  showInvite = true,
  showSignoff = true,
  headingLevel = 2,
}) {
  const { lang, t } = useLang();
  const autoId = useId();

  const nested = headingLevel === 3;
  const headingId = id ? `${id}-heading` : `committee-heading${autoId}`;

  const Root = showHeading ? "section" : "div";
  const Heading = nested ? "h3" : "h2";
  // Cards sit one level below the heading directly above them: the component's
  // own h3 when it renders one, otherwise the page-supplied h2 (About passes
  // showHeading={false} headingLevel={3} under its own h2).
  const CardHeading = showHeading && nested ? "h4" : "h3";

  return (
    <Root
      className={nested ? "committee committee--nested" : "committee"}
      id={id}
      aria-labelledby={showHeading ? headingId : undefined}
    >
      {showHeading && (
        <>
          <Heading
            id={headingId}
            className={
              nested
                ? "committee__heading committee__heading--nested"
                : "section-title committee__heading"
            }
          >
            {t(COMMITTEE.heading.ta, COMMITTEE.heading.en)}
          </Heading>
          {!nested && <div className="divider" aria-hidden="true" />}
        </>
      )}

      {showInvite && (
        <p
          className={
            nested
              ? "committee__invite committee__invite--nested"
              : "committee__invite section-subtitle"
          }
        >
          {t(COMMITTEE.invite.ta, COMMITTEE.invite.en)}
        </p>
      )}

      {/* role="list" keeps list semantics in Safari/VoiceOver once list-style is none */}
      <ul className="committee__grid grid-3" role="list">
        {COMMITTEE.members.map((member) => {
          // President and Secretary are the data module's designated contacts.
          const isLead =
            member === PRIMARY_CONTACT || member === SECONDARY_CONTACT;
          const name = t(member.name.ta, member.name.en);
          const role = t(member.role.ta, member.role.en);
          const phone = formatPhone(member.phone);

          return (
            <li
              key={member.phone}
              className="committee-card card committee-card--static"
            >
              <p
                className={
                  isLead
                    ? "committee-card__role committee-card__role--lead"
                    : "committee-card__role"
                }
              >
                {role}
              </p>

              <CardHeading className="committee-card__name">
                {name}
                {lang === "en" ? (
                  <span className="committee-card__name-ta" lang="ta">
                    {member.name.ta}
                  </span>
                ) : (
                  <span className="committee-card__name-en" lang="en">
                    {member.name.en}
                  </span>
                )}
              </CardHeading>

              <a
                className="committee-card__tel"
                href={telHref(member.phone)}
                aria-label={`${name}, ${role} — ${phone}`}
              >
                <span className="committee-card__tel-icon" aria-hidden="true">
                  📞
                </span>
                <span className="committee-card__tel-number">{phone}</span>
              </a>
            </li>
          );
        })}
      </ul>

      {showSignoff && (
        <p
          className={
            nested
              ? "committee__signoff committee__signoff--nested"
              : "committee__signoff"
          }
        >
          {t(COMMITTEE.signoff.ta, COMMITTEE.signoff.en)}
        </p>
      )}
    </Root>
  );
}
