# Layline judgment rebalance — design

2026-07-13

## Problem

The previous layline rev softened the navigator too far, in two ways:

1. **Wrong wind.** Laylines are called on `mean + trend·t`. That filters out the
   oscillation the boat is actually sailing in — the navigator both ignores the
   observable current wind *and* implicitly knows the current lift/header will
   revert. Real navigators are good at calling the layline **in the current
   wind**; what they can't do is predict the shifts that arrive after the tack.
2. **Distance-blind error.** The judgment error (`laySig` slider, one gaussian
   draw per race) is the same angular size at 800 m as at 50 m. Real layline
   calls sharpen as the mark gets closer.

## Change

Applied identically in the two sim cores (`public/index.html`, `tack_now.html`).

### 1. Judge laylines in the slow current wind

`simulateOne` already tracks the fast OU residual `dev` separately, so the slow
current wind is `twd − dev` (= mean + trend·t + oscillation). Pass it through
`stepBoat` into `policy` and use it as `judgeW` for the layline test only.

- Models a crew that has perfectly averaged the last minute of wind: accurate
  now, blind to post-tack evolution. Overstands when a lift reverts after the
  tack — naturally, not via an error knob.
- The header rule (shift vs trend-adjusted mean) is unchanged.
- The `canFetch` free leg keeps using raw `twd` — that's physics, not judgment.

**Amendment (same day):** judging on the slow current wind *alone* made the
layline trigger a first-passage problem on an oscillating signal: boats
arriving at the layline zone lifted follow the rotating layline into the
corner and tack up to a full oscillation amplitude past the mean-wind line
(measured: median final tack +5.1° past, 50% of boats > +5°, vs +1.0° / 11%
before the rev). Fix: the navigator holds **two observable laylines** — the
current slow wind and the expected wind (mean + trend) — and tacks at
whichever is reached **first**. Arriving headed → tack on the header at the
current-wind layline; arriving lifted → tack at the expected-wind line rather
than chase the lift into the corner. Post-tack shifts still create honest
over- and under-standers (measured: median +0.2°, p10 −4.0°, p90 +6.5°).
No new prescience: mean + trend is the same reference the header rule already
treats as observable.

### 2. Distance-scaled judgment error

Replace the per-race `layErr` angle with a per-race unit draw `z = gauss(rng)`,
still shared by both duel boats (same helm decides both futures). At each
layline evaluation:

```
m = P.lay + z · P.laySig · min(1, dist / 500)
```

where `dist` is the boat's current distance to the mark and D₀ = 500 m is
fixed. The slider keeps its name and ±3° default but now means "judgment σ when
far from the mark"; the existing 30 m cutoff still disables the rule at the
mark.

No new sliders, no settings-schema or server (`index.js`) changes.

## Validation

Recreate the node harness from the sim core (old scratchpad copy is gone) and
check:

- Canonical scenarios keep sane verdicts: header → tack, lift → hold,
  persistent shift → hold, no-shift → one-extra-tack cost.
- Overstand/miss-penalty rate stays ≈ 0; average tacks per boat stays small
  (historical failure modes: layline thrash near the mark, corner-chasing
  overstands).
- Webapp eyeballed against `npm run dev` mock beat.
