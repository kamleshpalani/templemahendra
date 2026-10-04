# Temple images

Image files here are served from the site root, e.g.
`public/images/deities-alankaram.jpg` → `https://www.templemahendra.in/images/deities-alankaram.jpg`.

## Required

| File | Used by | Notes |
|---|---|---|
| `deities-alankaram.jpg` | About page (sanctum photograph), Home hero at ≤640px | The supplied full portrait of the three deities in floral alankaram — Sri Lingammal (left, green saree), Sri Renukadevi (centre), Sri Chinnammal (right, red saree). 916×1600px, JPEG quality 80. The About page contains the full photograph; the mobile hero uses this portrait to avoid the much tighter crop of the landscape version. |
| `temple-hero.jpg` | Home page hero background at >640px | A landscape crop of the same photograph, centred around all three deities' faces. 1280×857px, JPEG quality 80. Referenced as `/images/temple-hero.jpg` in `src/pages/Home.css`. |

The supplied original is 916px wide. The hero export is upscaled to 1280px;
this does not add detail. For sharper replacements, use an original ≥1200px
wide and export at JPEG quality ~80. Keep all three faces within the centre
of the landscape crop, since the hero uses `background-size: cover`.

If these files are absent, the About page hides its photograph automatically and the
Home hero falls back to its maroon gradient — nothing breaks.
