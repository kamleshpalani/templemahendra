# Free offline Panchangam calculations

Public pages omit New Moon / Amavasai announcements, events, poojas and calendar
labels by committee request. Calculations and admin records are retained;
the omitted Tithi is not relabelled as a different lunar day.

No paid API, runtime Node server or external calendar requests are needed.
The homepage displays today's API-backed details in a running notice immediately
below its hero, including named daytime Gowri periods, lunar/solar details,
timing windows, observances and source. It follows the selected UI language and
refreshes when the IST date changes. Unavailable fields are omitted from the
homepage notice, not guessed; the full calendar retains explicit missing-data labels.
The notice pauses on hover/focus and has a pause control; reduced-motion users
get a stationary, horizontally scrollable version with a full-calendar link.
A separate gold Notice Board panel appears inside the homepage content container,
immediately above Upcoming Events & Announcements. It uses the existing active announcements, upcoming events
and published announcement/event/pooja widgets (including linked pooja dates
and times). Edit these through the existing admin dashboard. Announcement
links open the full notices on the Events page; widget/event links jump to the
upcoming section. The old static homepage Notice card grid is removed so notices
appear in a bottom-to-top scrolling notice board with wrapping text. The Panchangam
strip remains horizontal. Pausing or keyboard focus makes the notice board a
stationary, manually scrollable list so every full notice remains accessible.
It has independent pause/resume, hover/focus pause, reduced-motion support,
and explicit loading, empty and retry states.
The linked Events page groups committee-published poojas, Pournami schedules,
events and notices into four anchored panels with consistent responsive cards.
Empty sections offer temple contact rather than calculated or invented events.
Event cards on that page omit the redundant link back to the same Events page;
homepage cards retain it. Retry clears stale results while loading fresh data.
PHP serves committed daily calculation data for 2020–2035. Generate it with
`npm --prefix frontend run generate-panchangam` after installing frontend dependencies.
Deploy `backend/data/panchangam` with the backend.

## Method and limits

- Astronomy Engine 2.1.19, MIT-licensed: https://github.com/cosinekitty/astronomy
- Tithi: geocentric tropical Moon–Sun ecliptic elongation divided into 12-degree
  intervals, evaluated at local sunrise. The next boundary is supplied as a UTC
  timestamp and displayed in Asia/Kolkata. This does not require a sidereal ayanamsa.
- Sunrise/sunset: apparent solar upper-limb rise/set, standard atmospheric
  assumptions and a sea-level horizon. Local terrain is not included.
- Rahu Kalam, Yamagandam and Gulikai: weekday-specific eighths of actual daylight.
- Brahma Muhurtham: the convention of 96–48 minutes before sunrise.
- Nalla Neram and Nakshatram require the existing committee-entered approved data.
  No arbitrary weekday table or unvalidated sidereal approximation is substituted.
- Separately labelled **calculated daytime Gowri Nalla Neram** uses the
  MIT-licensed nalla-neram-js weekday ordering, adapted to eight equal parts of
  local sunrise-to-sunset daylight. Amirtham, Labam, Dhanam, Sugam and Uthi are
  shown; Rogam, Visham and Soram are excluded. These are not regular printed
  calendar Nalla Neram or certified muhurthams. Rahu/Yamagandam overlaps are
  not subtracted. Morning/afternoon cards split at civil noon; named windows
  below retain their full boundaries. Nighttime Gowri is not included.
  Attribution and licence: [nalla-neram-js](licenses/nalla-neram-js.txt).
- Lunar markers represent tithi **at sunrise**, not a complete festival/fasting
  rule engine. A short tithi may not occur at any sunrise. Temple festival and
  pooja dates must be maintained through the existing calendar admin.
- Fixed Gregorian festival guesses and mean-lunar-cycle calculations are removed.

`backend/config/panchangam_location.json` uses the user-provided Google Maps
temple pin: **9.2101171, 77.7736112** (Sri Renuka Devi Yellamma Kovil).
After changing coordinates, regenerate all data. Elevation remains a sea-level
assumption; local terrain and priest-approved observance rules still need confirmation.

Committee records override calculated lunar values and timing windows. The
committee source and location remain visible; computed solar values and tithi
end times are cleared for those records to avoid attributing them to another source.

## Validation

Run `php tests/panchangam-calculated.php`. It checks every day in the supported
range, daylight-window lengths/order, missing-data honesty and two published
US Naval Observatory lunar-phase reference times within three minutes.
It also checks daytime Gowri bounds and bilingual labels across the full range,
the Sunday ordering against the attributed table, daylight scaling and invalid
input rejection. These checks validate the implementation, not the tradition.
This is astronomical validation, **not** priest certification of observance rules.
The MIT dependency is build-time only; generated numerical results contain no
copied third-party Panchangam tables.
