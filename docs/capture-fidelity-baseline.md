# Capture-fidelity baseline (Day 1 of the research+experiment track)

Per the plan at `~/.claude/plans/do-you-want-crystalline-summit.md` — every later experiment subtracts from these numbers.

## How to reproduce

```bash
# Prereqs
pnpm dev                  # canvas at :3000
# In Chrome: reload DesignJS extension, navigate to the reference URL,
# Cmd+Shift+R, click extension, "Capture page", wait

node scripts/capture-compare.mjs <url>   # pixel-diff scorecard
node scripts/capture-diff.mjs <url>      # per-element structural drift
```

Outputs land in `/tmp/capture-compare/`.

## Baseline runs

State of `packages/chrome-extension/src/` at capture time:
- A.1 (`5226b68`) same-origin iframe inlining
- A.2 (`debdc1d`) author-CSS supplement
- `59491e6` auto-scroll-and-settle before whole-page capture
- `989fe18` always emit inherited properties on captured root

### docs.python.org/3/tutorial/introduction.html

| Metric | Source | Captured | Delta |
|---|---|---|---|
| Pixel diff (capture-compare, 1200×4000 scoring window) | — | — | **9.39%** |
| Elements | 1,755 | 1,706 | -49 (-2.8%) |
| Paired by walk-order UID | — | 1,705 | 99.7% pairing |
| CSS rules | 350 | **6,947** | **+6,597 (19.8×)** |
| Document height | 10,853px | 11,209px (body) | +356px |
| Tag delta (top, by abs Δ) | DIV 114 | DIV 66 | **-48** |
| All other tags | identical (SPAN 1064, A 86, OPTION 105, IMG 3, etc.) | match | 0 |

**Sample fingerprint mismatch (50 paired elements, 30 properties each):**

| Property | Mismatch count | % of sample |
|---|---|---|
| width | 49 | 98% |
| height | 49 | 98% |
| color | 47 | 94% |
| text-align | 35 | 70% |
| line-height | 13 | 26% |

**Diagnosis confirmed by per-element drift table:**
The serializer emits resolved pixel values (e.g. `width: 1316px`) for every property
whose source authored value is `auto`. `getComputedStyle` resolves `auto` to the source
viewport's pixel measurement *before* our [skip-auto check at style-serializer.ts:238](packages/chrome-extension/src/capture/style-serializer.ts#L238)
ever runs. Result: captured elements are force-pinned to source-viewport dimensions
and break in the canvas iframe's different layout context. Most visible symptoms
(0×0 sidebar, mis-sized columns, page rendering mostly empty) trace back here.

Color drift is a separate compound bug — partly cascade interaction with the
GrapesJS CSS-explosion, partly the `INHERITED_DIFF` mechanism interacting with the
captured root being re-parented under GrapesJS' light-theme default body.

### en.wikipedia.org/wiki/Love (post-v0.3.5 + 8MB cap)

Pipeline at first measurement (2026-05-23): v0.3.5 + dedup hoist (`124c6f3`)
+ multi-column properties (`eacfb6d`). Diff tool with walk-alignment fix
(`bbd7da3`) and ε-tolerance (`39e8bae`).

The pipeline evolved through 2026-05-24 — the row below records the
2026-05-23 numbers as a frozen baseline. Post-2026-05-24 pipeline also
includes T1/L1/vertical-align properties (`8ad1c58` + initial-value skip
`af78be4`), stylable widening on built-in component types (`7714eb8`),
and the `add_css_rules` bridge tool with chunking (`9c99089` + `de26fbf`)
that finally lands author + dedup CSS in the canvas. The visible win:
Wikipedia anchor elements now resolve to their captured `display: flex`
instead of the prior `inline` fallback. Per-element sampled mismatches
should re-measure lower than 104 once a clean same-skin run is available.

| Metric | Source | Captured | Delta |
|---|---|---|---|
| Pixel diff (capture-compare, 1200×4000 scoring window) | — | — | **8.22%** |
| Elements | 6,930 | 6,931 | +1 |
| Paired by walk-order UID | — | 6,930 | **100% pairing** ✓ |
| Tag-identity check (post-`bbd7da3`) | — | 48/50 sample tagMatch (rest = expected `body`/`html` → `div` swaps) | ✓ |
| CSS rules | 1,619 | **841** | **-778 (dedup hoist — was 15,508 pre-`124c6f3`)** |
| Iframe DOM nodes | — | 7,758 | down from 22,425 pre-dedup |
| Document height | 23,090px | 20,931px (body) | -2,159px (-9.4%) |
| Sampled property mismatches (50-element fingerprint, 30 props each) | — | — | **104** |
| Near-miss px deltas filtered (ε=1px) | — | 25 | sub-pixel rounding noise |

**Top mismatching properties:**

| Property | Mismatch count |
|---|---|
| height | 22 |
| color | 14 |
| width | 13 |
| display | 8 |
| margin-bottom | 8 |

**Reading vs Python docs baseline:**

| Metric | Python docs (post-C) | Wikipedia Love | Direction |
|---|---|---|---|
| Pixel diff | 12.90% | 8.22% | better (whitespace match favors Wikipedia; lean on drift, not pixel diff) |
| Sampled mismatches | 102 | 104 | effectively even — Wikipedia is ~4× larger but drift rate per property is similar |
| UID pairing | 100% | 100% | unchanged |

**Diagnostic:** of the 8 remaining `display` mismatches, 7 were `<A>` elements
losing `display: flex` → `display: inline` after the capture lands in the
canvas. Initial hypothesis was a cascade fight; canvas DevTools inspection
revealed the actual cause was **GrapesJS' `parseHtml` silently stripping
`<style>` elements during import** — dedup-class rules never reached the
canvas at all (0 of 1,949 iframe stylesheets contained any `_djh*` rule).

**Resolved 2026-05-24** via the `add_css_rules` bridge tool (`9c99089`) +
chunking (`de26fbf`): CSS now routes through `editor.Css.addRules` directly,
bypassing parseHtml. Verified live: 100 `_djh*` rules + 233
`.mw-parser-output` rules land in the canvas iframe; `<a>._djh1` computed
display is `flex`. See [ADR-0011 2026-05-24 addendum](./adr/0011-browser-extension-architecture.md#addendum-2026-05-24--css-routing-via-the-add_css_rules-bridge-tool).

**Earlier measurement (pre-`bbd7da3`)** reported 399 sampled mismatches with
33 in `display`. Those numbers were a diff-script artefact: source-side and
captured-side walks diverged (source started at `body`, missed scroll-settle,
didn't drop `<head>`), so 78% of paired UIDs compared the wrong elements.
The 104/8 figures above are the first numbers measured after that fix.

**Capture-diff caveat — Wikipedia skin variants.** Subsequent diff runs
showed `[ALIGNMENT BUG] N of M paired UIDs have mismatched tags` because
Wikipedia serves the diff-script's logged-out Playwright session a
different Vector skin variant than the user's browser sees during capture
(`<CENTER>` / `class="floatleft"` legacy vs `vector-sticky-pinned-container`
2022). Workaround: append `?useskin=vector-2022` to the URL when running
`capture-diff`. Alignment is sensitive to "same URL, same skin, same
session" — a known limitation of comparing live pages against captures.

### Other fixtures — still TODO

| Fixture | Captured | Notes |
|---------|----------|-------|
| Wikipedia | ✅ 2026-05-23 (Love) | See row above |
| MDN article | — | |
| Tailwind landing | — | |
| Bootstrap demo | — | |
| rubychilds.com | — | Default scorecard target — capture before next pipeline change |

Capture these whenever convenient and append rows to the table above.

---

## Experiment results

### Experiment A — capture `<html>` instead of `<body>` (commits `24cb12c` + `70a7a25`)

**Qualitative result (user-confirmed):** sidebar TOC now visible (was 0×0
before), full "Introduction to Python" heading rendered, body paragraphs
visible, code blocks rendered. Major visible improvement vs baseline's
"mostly empty whitespace" output.

**Quantitative result:**

| Metric | Baseline | After A | Delta |
|---|---|---|---|
| Pixel diff (capture-compare) | 9.39% | **27.81%** | **+18.4 (regression)** ⚠ |
| Sampled property mismatches | 247 | 269 | +22 (slight regression) |
| color drift (50 sample) | 47 | 43 | -4 (improvement) ✓ |
| width drift | 49 | 50 | +1 |
| height drift | 49 | 50 | +1 |
| Paired by UID | 1705/1755 | 1705/1755 | unchanged |

**Metric weakness exposed.** The pixel-diff "regression" is a measurement
artifact. Before A, the capture was mostly empty whitespace, which
pixel-matched the *whitespace* of the source's scoring window — an
artificially low diff score. After A, the capture has real visible content
(sidebar, headings, paragraphs, code), and that content doesn't pixel-match
the source exactly (different positioning, colors, font rendering) — so the
diff number goes UP even though the capture is now *qualitatively faithful*.

**Going forward:** per-element drift is the truer metric (color, width,
height counts in the 50-element sample). Pixel diff is a misleading proxy
when one of the captures is essentially blank — re-interpret only when both
sides have comparable content density. Multi-page baseline (TODO above)
would help establish whether the metric is meaningful on simpler pages.

**Decision:** A stays — the qualitative wins are real and the per-element
profile is no worse. Move on to Experiments B + C (parser-strip root cause —
the width/height drift at 50/50 is the actual bug now).

### Experiment C — pre-inline styles via `mode: "inline"` (commit `2048128`)

**Qualitative result (user-confirmed):** *"Looks a lot better now."*

**Quantitative result — major win:**

| Metric | Baseline | After A | **After C** | Delta vs A |
|---|---|---|---|---|
| Pixel diff | 9.39%* | 27.81% | **12.90%** | -14.9 |
| Sample property mismatches | 247 | 269 | **102** | **-167 (-62%)** ✓ |
| color drift (50 sample) | 47 | 43 | **<6** | dropped out of top 5 ✓ |
| width drift | 49 | 50 | **<6** | dropped out of top 5 ✓ |
| height drift | 49 | 50 | **<6** | dropped out of top 5 ✓ |
| Paired by UID | 1705/1755 | 1705/1755 | **1755/1755** | 100% pairing ✓ |
| Captured rules | 6,947 | 6,948 | 10,329 | +3.4k (inline styles in CSS Manager) |
| Captured body height | 10,853 | 11,019 | **10,903** | within +50px of source |

\* baseline pixel diff was artificially low — mostly white-on-white match

**Top remaining mismatches:** display 12, font-family 8, background-color 8,
overflow 6, white-space 6 — all smaller, addressable.

**Architectural insight refuted from earlier hypothesis.** The 50/50 width
and height drift was NOT primarily caused by `getComputedStyle` resolving
`auto` to pixel values (though that's still partly true). It was caused by
GrapesJS' `<style>`-block explosion + CSS Manager cascade reorganization
fighting our hoisted classes. Moving styles to inline `style=""` attributes
bypasses that machinery entirely — the styles apply cleanly per-element
with no cascade rebinding. Width / height / color drift effectively
*disappear* from the top mismatchers.

**Decision:** C stays. Big win. We're at 12.90% pixel diff (well under the
25% abandon threshold, close to the 10% target). The per-element drift
metric — the truer one — is at 102 sampled mismatches, down 58% from
baseline. Per-stop-condition: "commit to current pipeline if A+B+C lands
Python docs ≤10% pixel diff AND median across 5-page fixture is ≤15%" — we
haven't run B yet and don't have the 5-page baseline, but on Python docs
alone we're already close.

### Experiment B — *not yet run*

Custom GrapesJS `parserHtml` / `parserCss` overrides. With C succeeding so
strongly by *avoiding* the GrapesJS parser/cascade path, the marginal value
of B (which would re-configure that path) is now lower. Likely deferred —
revisit if multi-page baseline shows worst-case pages still >25% diff.

## Stop conditions (from the plan)

- **Commit to current pipeline** if A+B+C lands Python docs ≤10% pixel diff AND median across the eventual 5-page fixture is ≤15%.
- **Abandon current pipeline** if A+B+C still >25% on Python docs AND Experiment D's preview iframe renders the same page <10%.
- **Hybrid** if A+B+C lands most pages <15% but worst case 20-30% — ship improvements AND ship D as opt-in preview toggle.
- **Accelerate ADR-0012 §2 CDP pivot** if GrapesJS' import design fundamentally prohibits high-fidelity preservation.
