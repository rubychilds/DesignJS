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

### Other fixtures — TODO

Full plan calls for N≥5 reference pages (Wikipedia, MDN, Tailwind landing,
Bootstrap demo, rubychilds.com) to establish a distribution. Deferred —
each requires a user-driven capture cycle (extension reload + navigate +
click extension + wait for capture to land), and we'd rather use the budget
on running experiments against the Python-docs baseline.

Capture these whenever convenient and append rows to the table above.

## Stop conditions (from the plan)

- **Commit to current pipeline** if A+B+C lands Python docs ≤10% pixel diff AND median across the eventual 5-page fixture is ≤15%.
- **Abandon current pipeline** if A+B+C still >25% on Python docs AND Experiment D's preview iframe renders the same page <10%.
- **Hybrid** if A+B+C lands most pages <15% but worst case 20-30% — ship improvements AND ship D as opt-in preview toggle.
- **Accelerate ADR-0012 §2 CDP pivot** if GrapesJS' import design fundamentally prohibits high-fidelity preservation.
