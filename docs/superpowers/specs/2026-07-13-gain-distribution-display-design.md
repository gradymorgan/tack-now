# Gain-distribution display — design

2026-07-13

## Problem

The headline "% of futures where tacking wins" collapses the paired-duel time
deltas (Δt = hold finish − tack-now finish, already collected as `res.diffs`)
to a probability. It hides magnitude: "53%, median +2 s" is a toss-up, "53%,
median +25 s" is a high-stakes coin flip. Consequences of a choice (e.g. a
port-approach penalty) shift the whole Δt distribution, not just the win rate.

## Change

Display only — no simulation changes. Applied to the webapp
(`public/index.html`) and mirrored to the playground (`tack_now.html`).

### 1. Probability × magnitude headline

The verdict line pairs the win% with the median Δt:
"Tack now — wins 62% · median +12 s" / "Hold — tacking wins 38% · median
−9 s" / "Toss-up — median +1 s · sail your plan". The drawer's Decision card
keeps its median row.

### 2. Δt distribution strip

A small canvas histogram in the instrument header between the verdict and the
gauges, labelled "seconds gained by tacking":

- Symmetric range ±L, L = p95 of |Δt| rounded up to 10 s (min 10); tails
  clamp into the end bins. Symmetry keeps zero centred so the mass balance
  reads at a glance.
- 24 bins, 2 px surface gaps, rounded tops; teal (`--tack`) right of zero =
  futures where tacking wins, amber (`--hold`) left = holding wins — the same
  polarity colors the route fans already use (pair validated for CVD and
  contrast on both light and dark panel surfaces).
- 1 px `--ink-3` zero line; small `--ink` triangle marks the median.
- Axis end labels −L / 0 / +L in text tokens; the caption names the measure so
  identity is not color-alone.
- Redraws live during the chunked Monte Carlo run (hooked into `drawAll`),
  hidden-empty until ~20 sims are in.

Compact (max-height 720 px) header keeps the strip at reduced size — it is
the feature, so it never collapses entirely.

## Validation

Headless Chrome screenshots at 1024×600 (7" tablet target), light and dark,
webapp demo mode and playground; check header fits on one row and the strip
mass sits on the winning side of the zero line consistent with the headline.
