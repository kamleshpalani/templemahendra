# Sacred Light v3 — Design System Guide

Single source of truth for the public site (React/Vite) **and** the PHP admin.
`tokens.css` is copied to `backend/admin/assets/tokens.css` by `npm run sync-tokens`
(runs automatically before `dev`/`build`). Never edit the generated copy.

## Files (load order)

| File | Purpose |
| --- | --- |
| `tokens.css` | Colour, status, glass, blur, border, shadow/glow, radius, spacing, type, motion, z-index, layout tokens |
| `base.css` | Reset, ivory ground + aurora + grain, typography defaults, focus ring, scrollbars, reduced-motion, no-backdrop fallback, print |
| `layout.css` | `.container`, `.section`, `.section-head`, `.eyebrow`, `.divider`, `.grid-*`, `.bento`, `.split`, `.page-hero`, `.crumbs` |
| `components.css` | `.glass`, `.btn`, fields, `.switch`, `.chip`, `.card`, `.badge`, `.alert`, `.callout`, `.tabs`, `.table`, `.pagination`, `.menu`, `.modal`/`.dialog`/`.drawer-panel`, `.toast`, `.skeleton`/`.spinner`/`.progress`/`.stepper`, `.empty-state`, `.stat`, `.avatar`, `kbd`, `[data-tip]` |
| `utilities.css` | `.sr-only`, `.skip-link`, `.stack`/`.cluster`, text + spacing helpers, `.rise`, `.reveal`, `.page-enter`, responsive `hide-*` |

## Rules for page / component stylesheets

1. **Tokens only.** No raw hex/rgb colours in page CSS. Use `var(--maroon-600)`, `var(--glass-2)`, `var(--text-3)`, `var(--shadow-md)`, … Semantic accents: `--moon-*` only for lunar/panchangam content, `--sage-*` only for auspicious-time content, status tokens for status.
2. **Compose primitives, don't restate them.** A page card is `.card` + a page modifier for layout; buttons are `.btn` variants; forms use `<Field>`; lists of status use `.badge`.
3. **No inline `style={{}}` for visual styling** (only for dynamic data such as `--i` stagger index or a computed width).
4. **Glass budget.** At most one `backdrop-filter` surface per visual layer; never nest blurred surfaces three deep; large full-width bands use gradients, not blur.
5. **Dark surfaces** (`.page-hero`, `.card--ink`, `.section--ink`, footer) use `--text-on-dark*` and gold accents; light surfaces use `--text-1/2/3`.
6. **Typography.** Headings inherit `--font-display` (Playfair + Noto Serif Tamil); Tamil documents (`:lang(ta)`) automatically switch heading family. Body is `--font-body`. Sizes come from `--text-*`; never hardcode `rem` sizes for type.
7. **Motion.** Use `--transition`, `--transition-slow`, `.rise` (stagger via `--i`), `.reveal` (+ `useReveal()`); durations ≤ 0.6s; everything respects `prefers-reduced-motion` automatically.
8. **Icons.** Lucide via `react-icons/lu` for UI chrome (nav, buttons, badges, empty states, toasts). Emoji are allowed only as cultural content glyphs inside copy.
9. **Breakpoints** (literal): 480 · 640 · 820 · 1024 · 1280 · 1536. Mobile has a 66px floating bottom nav — keep `body` padding (already handled) and place fixed elements above it.
10. **Accessibility.** Every interactive element ≥ 44px tall on touch, visible `:focus-visible`, `aria-*` from `<Field>` for form errors, `role="status"`/`alert` for feedback, headings in order, `aria-label`s bilingual via `t()`.

## React primitives (`src/components/ui`)

| Component | Use |
| --- | --- |
| `Button` | `variant` primary·gold·outline·outline-light·soft·ghost·danger·success; `size` xs·sm·md·lg; `to`/`href`; `loading`; `icon`; `iconOnly` |
| `Field`, `PasswordInput`, `IconInput`, `Switch`, `Chip` | Form wiring with `aria-describedby`/`aria-invalid`, hints, errors |
| `Badge` | `tone` gold·success·warning·danger·info·moon·sage·muted·on-dark; `live` |
| `Alert` | `tone` success·error·warning·info; `title`; `onClose` |
| `SegmentedControl` | Keyboard-navigable tablist for filters (`items`, `value`, `onChange`) |
| `PageHero` | Inner-page banner: `variant`, `eyebrow`, `title`, `lead`, `crumbs`, `actions`, `aside` |
| `SectionHeader` | `eyebrow`, `title`, `subtitle`, `align` center·left·split, `actions` |
| `Modal` | Focus-trapped glass dialog / mobile sheet; `title`, `eyebrow`, `description`, `size` |
| `EmptyState`, `ErrorState`, `PageLoader`, `SkeletonCards`, `SkeletonText` | Loading / empty / error states |
| `useReveal()` (hook) | Scroll-reveal for `.reveal` elements |
| `lib/templeTime.js` | IST clock, open/closed, next pooja, nalla neram tables |

## Status colours

| State | Tokens |
| --- | --- |
| success | `--success`, `--success-fg`, `--success-bg`, `--success-border` |
| warning | `--warning*` |
| danger / error | `--danger*` |
| info | `--info*` |
| neutral | `--neutral-*` |

## Z-index layers

`--z-below -1` · `--z-base 1` · `--z-raised 10` · `--z-sticky 100` · `--z-header 1000` · `--z-drawer 1100` · `--z-fab 1200` · `--z-popover 1500` · `--z-modal 2000` · `--z-toast 3000` · `--z-skip 4000`
