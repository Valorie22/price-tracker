# DESIGN NOTE

Two things are designed here: a scraper that has to keep working unattended, and an
interface whose job is to tell the truth about it. Sections 1–3 are the reliability
engineering. Section 4 is the interface.

*(Sections 1–3 are completed at the end of the build with real production numbers;
section 4 was written before any UI code, as the plan it is.)*

---

## 4. The interface

### 4.1 What this thing is

It is an **instrument**. It watches something that moves and reports what it saw, including
when it failed to see anything. That is the whole design brief, and it settles a surprising
number of small decisions:

- A gap in the price line is **drawn as a gap**. Never interpolated, never smoothed. An
  interpolated line is a claim about a measurement that was never taken.
- Failures are **not muted, collapsed or filtered out by default**. On this dashboard,
  showing them is the feature.
- Every reading carries its provenance — which strategy read it, how long it took, which
  attempt it was. A number with no origin is a rumour.

The visual vernacular that fits is measurement equipment: strip charts, tick marks, hairline
rules, tabular figures, a large calm primary reading and quiet everything-else.

### 4.2 Tokens

```
paper     #E9EBEE   cool grey-blue ground — the instrument's body
panel     #FDFDFD   the card faces
ink       #131A22   text
rule      #C6CBD1   hairlines, chart grid
drop      #0F7B5A   price fell
rise      #B4442C   price rose
degraded  #8A6A1F   retried, stale, structure changed
idle      #6B7580   no data, inactive
```

Kept as given. The palette already does the one hard thing a price tracker's palette has to
do: green means *cheaper*, not *good*, and red means *dearer*, not *broken* — so the failure
state needs its own colour, which is what `degraded` is for. Three additional greys derived
for surfaces (`#F4F5F7` sunken, `#DDE1E6` hover, `#8892A0` secondary text) and one focus
blue (`#2A6FB5`) that appears **only** on keyboard focus rings, where a distinct hue is an
accessibility requirement rather than decoration.

### 4.3 Type

| Role | Face | Size / weight |
|---|---|---|
| Display reading (current price) | Instrument Serif | 56px / 400, tabular |
| Product name | Instrument Serif | 28px / 400 |
| Section headings | IBM Plex Sans | 15px / 600 |
| Body, labels, controls | IBM Plex Sans | 14px / 400–500 |
| Small print | IBM Plex Sans | 12.5px / 400 |
| **Numerals and timestamps in columns** | IBM Plex Mono | 12.5–13px / 400, `tabular-nums` |

Mono is for aligned figures only — log timestamps, durations, price columns — never for
labels. Labels in mono are a costume; columns in mono are legibility.

Scale: 12.5 / 14 / 15 / 17 / 20 / 28 / 56. The jump from 28 to 56 is deliberate: the current
price is the one thing the eye should land on first, and everything else stays quiet so it can.

### 4.4 Layout

A fixed left rail (216px) holding the three destinations and an unread-alert count; content
in a single column, max 1180px. At ≤900px the rail becomes a top bar. At 360px everything
is one column with the strip chart at reduced height and the log table reflowing to stacked
rows — no horizontal scroll anywhere.

Surfaces are **panels with a 1px rule, not cards with a shadow**. Three shadows are used in
the whole application (command palette, toast, hover tooltip) and they are all for things
that genuinely float above the page.

### 4.5 The strip chart

The characteristic object. One graphic that answers "what has the price done?" and "did the
scraper actually work?" at the same time.

```
 ₹1,65,813 ┤                                    ╭──────
           │                          ╭─────────╯
 ₹1,29,249 ┤────────────╮    (gap)    ╱
           │            ╰────╴  ╶────╯
           ├─────────────────────────────────────────── stock band
           │▌▌▌ ▌▌  ▌▌▌▌  ▌ ▌▌▌ ▌ ▌▌▌▌▌▌▌▌ ▌▌▌ ▌▌▌▌▌▌▌▌  attempt ticks
             ▲ filled = success   ▲ half = retried→ok   ▲ hollow+cross = failed
```

- **Price line** — 1.5px, `ink`. Broken wherever consecutive readings are more than 1.6×
  the expected interval apart. The break is drawn as a real gap with a dotted connector and
  a hover label saying how long it lasted and why.
- **Attempt ticks** — one per row in `scrape_logs`, on the baseline. Filled = success,
  half-height = this attempt was retried and a later one succeeded, hollow with a cross =
  failed. This is the honest-logging requirement rendered as a picture.
- **Stock band** — a 6px strip beneath the line: `drop` in stock, `degraded` low stock,
  `rise` out of stock, hatched for unknown. A thin band, not a second axis.
- **Crosshair** — follows the pointer, snaps to the nearest reading, and shows price, stock,
  strategy, duration and attempt number in a readout that does not cover the line.
- **Range** — 24h / 7d / 30d / all, as a segmented control.

Built as hand-written SVG rather than with a charting library. Three of its five features —
per-attempt baseline glyphs in three styles, genuinely broken paths, and a state band — are
things a general-purpose chart component makes harder rather than easier, and this graphic is
where the brief says to spend the effort.

### 4.6 Motion and states

Motion happens for exactly two reasons: the user did something, or a state changed that they
should notice (a new point landing on the chart; a row arriving in the log during a manual
scrape). Everything is 120–200ms and everything is inside
`@media (prefers-reduced-motion: no-preference)`.

Loading uses **skeletons shaped like the content**, not spinners — a spinner tells you
nothing about what is coming. Errors say what happened and what to do next, with the actual
error code visible, because this is a tool for someone who wants to know.

### 4.7 Quality floor

Responsive to 360px. Visible keyboard focus on everything focusable, including the chart's
range control and every log row. `prefers-reduced-motion` respected. Colour is never the only
carrier of meaning — outcome dots have shapes, the stock band has a hatch pattern, deltas
carry a sign. Target: Lighthouse accessibility ≥ 95.
