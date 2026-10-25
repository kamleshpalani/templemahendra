# Retired suites

These browser suites tested features the project deliberately removed. They are
kept for their history, not run, and not part of the regression.

| Suite | What it tested | Why it is retired |
| --- | --- | --- |
| `accounts-ui.mjs` | Devotee sign-up, sign-in, the `/account` dashboard | Devotee accounts were replaced by family registration (`docs/registration/SPEC.md` §1, migration 009); the spec lists this file for deletion. `/account` and `/login` are no longer routes. |
| `notifications-ui.mjs` | The signed-in devotee's notification bell and the `/notifications` inbox | The in-app channel was retired with sign-in (`NOTIFY_CHANNELS` is email, WhatsApp, SMS); `/notifications` is no longer a route. |
| `notify-prefs-ui.mjs` | A signed-in devotee's notification preferences page | Preferences went with sign-in; a family manages updates consent through registration and the unsubscribe link in every message (`backend/api/n.php`, covered by `notifications-api.mjs`, `notify-providers.mjs`). |

What replaced them is covered by `public-e2e.mjs` (the family-registration
entry points), `registration-api.mjs`, `admin-registrations.mjs`,
`notifications-api.mjs` and `admin-notifications.mjs`.
