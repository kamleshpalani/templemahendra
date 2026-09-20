# Defect register

Severity: S1 critical · S2 high · S3 medium · S4 low.
Defects found before this register existed are listed from the PR history.

| ID | Module | Sev | Description | Steps / expected / actual | Root cause | Fix | Retest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D-001 | Homepage settings | S3 | Pournami toggle saved but homepage ignored it | Toggle off in admin → reload home; expected section hidden; actual visible | Frontend never read `show_pournami_section` | #15 | passed (browser) |
| D-002 | Sevas | S2 | No public booking form | Open /sevas; expected Book control; actual call/visit text only | Form removed earlier | #16 | passed |
| D-003 | Sevas | S2 | "Book" click swallowed by overlay | Click Book; expected modal; actual nothing | Decorative overlay above button | #17 | passed |
| D-004 | Seva booking API | S1 | HTTP 500 on submit (PHP 8.1 fatal) | Submit valid form; expected 201; actual 500 | Never-returning arrow fn | #25 | passed |
| D-005 | Notifications admin | S2 | Sent campaign detail page crashed | Open sent campaign; expected KPIs; actual fatal | Retired KPI referenced | #26 | passed |
| D-006 | Admin auth | S2 (security) | Disabled committee accounts kept live sessions | Disable user with open session; expected 403/redirect; actual still working | Session never revalidated | #27 | passed |
| D-007 | Layout | S4 | Mobile drawer stayed open on same-page tap | Tap Home while on Home; expected drawer closes; actual stays | Nav handler skipped same route | #27 | passed |
| D-008 | Admin nav | S2 | YouTube Automation link 404 | Click link; expected page; actual 404 | Page specced, never built | #29 | passed |
| D-009 | Live settings | S2 | Disconnect YouTube confirm never submitted | Confirm; expected disconnect; actual no-op | Confirm hook ignored `form=` | #30 | passed |
| D-010 | Live settings | S3 | Unchanged OAuth ID re-enabled Live while revoked | Re-save; expected stays off; actual Live on | Change detection by value | #31, #32 | passed |
| D-011 | Live SEO | S3 | Crawlers got 404 for `/live-darshan/archive` | Fetch as crawler; expected 200 static metadata; actual 404 | Archive path treated as slug | #41 | passed (browser + suite) |
| D-012 | Docs | S4 | README claimed `schema.sql` contained all migrations | Fresh install per README; expected working; actual missing 012–014 | Stale sentence | #42 | passed |
| D-013 | Admin auth | S2 (security) | Tenth failed sign-in locked the account in the DB but the page showed the generic "invalid" message | Fail 10× → expected "temporarily locked"; actual generic error | `adminLogin()` returned null after recording the lock and `login.php` only checked the lock before the attempt | gap-audit PR (login.php second `adminAccountLockedFor` check) | passed (`tests/admin-auth.mjs`) |
| D-014 | Live admin | S3 | `tests/admin-live.mjs`: "only the edited columns changed" reports `description_en,scheduled_end_at` drift; form-drawer axe check @1440 fails | Run suite on master; expected 235 pass; actual 233/235 | Not yet analysed (fails identically on master, independent of the auth work) | open | — |
| D-015 | Notifications tests | S3 | `tests/admin-notifications.mjs` targets retired `inapp`/`push` channels and crashes mid-run | Run suite on master; expected pass; actual 39/47 + crash | Suite not updated when channels were retired (G-18) | open | — |
