# Phase 5 — per-stream share previews

`/live-darshan/:slug` must describe the same public broadcast to link unfurlers
and browsers. Reuse `api/og.php`, `<Seo>`, `liveLoadBySlug()` and the public
stream shape; no provider API calls, credentials, new migration or dependency.

- Published, non-deleted streams in every public status: bilingual title and
  description with the same other-language fallback as the player. Description
  uses the page lead when blank, collapses whitespace and caps at 200 Unicode
  code points. Text is escaped, never interpreted as markup.
- Canonical and `og:url` use the saved slug and discard query/fragment noise;
  numeric ID aliases resolve to that slug. The list route keeps static metadata
  even when it features a live stream. Schedule metadata remains static.
- `og:type=video.other`, Twitter large image, stream thumbnail (including
  validated HTTPS provider images), then the site's existing fallback images.
  Remote images are referenced without fetching them or guessing dimensions.
- Drafts, deleted rows, invalid and unknown slugs: crawler HTTP 404 and
  `noindex,nofollow`, with no broadcast data disclosed. A database connection
  failure returns HTTP 503, no-store and Retry-After. Missing migration 011
  behaves like the existing public API: no stream found.
- Crawler language uses `?lang=ta|en` or the existing Accept-Language policy;
  browser language uses the existing visitor preference. Canonicals are neutral.
  Previews vary on language/user-agent; stream success caches for 60 seconds,
  stream errors are not cached. Social networks control their own unfurl cache.

Verify Tamil/English, fallback copy, lifecycle states, aliases, hidden records,
escaped content, thumbnail safety and canonical queries against MySQL 8 with
`node tests/live-og.mjs`. Verify React metadata and sharing in the browser and
run the existing `tests/og.mjs` regression.
