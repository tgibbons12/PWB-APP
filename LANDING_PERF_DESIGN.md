# Landing Performance — Design Note

Integrating [naclandapp](https://github.com/tgibbons12/naclandapp) into PWB so the
two greyed lines on ACARS RWY PERF/W&B (`LANDING CONDITIONS>` at 1R and
`LANDING RWY DATA>` at 3R) become live.

## Why these two sources together

Neither source is sufficient alone:

- **SimBrief `<tlr><landing>`** gives real runway geometry for the destination —
  identifiers, LDA, gradient, magnetic course, headwind/crosswind components,
  elevation, max landing weight dry/wet — plus a planned VREF and dry/wet
  distances. But only at the single weight and condition it planned for. There
  is no interpolation table, and nothing at all for contaminated runways.

- **naclandapp `fleetRegistry.js`** is certified-table math: `calculate(state)`
  returns VREF/VAPP and required landing distance across the full TALPA RCAM
  braking-action range (RwyCC 6 down to 0). But it knows nothing about which
  runway you're landing on.

Combined: naclandapp computes the numbers, SimBrief supplies the runway they're
assessed against, and the crew enters the conditions.

## Input mapping

| `calculate()` input | Source |
|---|---|
| `landingWeight` | SimBrief `est_ldw`, overridden by loadsheet if entered |
| `pressureAlt`   | Destination runway `elevation` corrected by altimeter |
| `oatC`          | Crew entry (LANDING CONDITIONS) |
| `headwind`      | SimBrief `headwind_component` for the selected runway |
| `flap`          | Crew entry — FULL / 3 |
| `reversers`     | Crew entry |
| `brakingAction` | Crew entry — RwyCC, the RCAM piece SimBrief has no equivalent for |

## Where the code lives

`fleetRegistry.js` is plain client-side JS and PWB's frontend is also
React/Vite, so the performance math needs **no backend work**. It runs in the
browser exactly as it does in naclandapp.

- Copy `naclandapp/src/lib/` → `PWB-APP-repo/frontend/src/landing/`
  (including anything `fleetRegistry.js` imports).
- Backend only needs to expose the XML's `<landing>` block in `xml_data`.

## Backend work

`parse_xml_raw` currently ignores `<tlr><landing>` entirely. Add a
`landing` key to `xml_data`:

```
landing: {
  airport, planned_runway, planned_weight, flap_setting,
  wind_direction, wind_speed, temperature, altimeter, surface_condition,
  distance_dry: { weight, flap, brake, reverser_credit, vref, actual, factored },
  distance_wet: { ... same ... },
  runways: [ { id, length, lda, elevation, gradient, magnetic_course,
               headwind, crosswind, ils, max_weight_dry, max_weight_wet } ]
}
```

Purely additive — nothing existing reads these keys, so it can't affect takeoff.

## CDU pages

**ACARS LANDING CONDITIONS 1/2** — mirrors the takeoff conditions page:

```
1L  <DEST> RWY 1        1R  WIND
2L  <DEST> RWY 2        2R  OAT/QNH
3L  <DEST> RWY 3        3R  PLW        (planned landing weight)
4L  SURFACE / RwyCC     4R  FLAP
5L  LEVEL               5R  REVERSERS
6L  <PERF/W&B           6R  REQUEST* -> SEND>
```

**ACARS LANDING RWY DATA** — one page per requested runway:

```
        <DEST> <RWY>   <LDA>FT
        RwyCC n  OAT nn   <gradient>
VREF    LDR              VAPP
MAX LW  LDA REMAINING    BRAKING
```

Flag prominently when required distance exceeds LDA, and when landing weight
exceeds `max_weight_dry`/`max_weight_wet`.

## Honest limitations to carry into the UI

1. **SimBrief's own distances are planned-condition only.** They're shown as a
   cross-check against naclandapp's computed figure, not as the answer. If the
   two disagree materially that's worth surfacing rather than hiding.
2. **RwyCC is a crew entry, never inferred.** Deriving a braking action code
   from SimBrief's `surface_condition` string would be inventing safety-relevant
   data. It stays blank (amber, mandatory) until entered.
3. **This is a simulation aid.** Same standing caveat as the takeoff side.
