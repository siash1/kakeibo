---
name: kakeibo
description: Two grounds, one site — a warm paper account book for the visitor, a terminal for the machine's own record.
colors:
  paper-50: "oklch(0.985 0.006 85)"
  paper-100: "oklch(0.968 0.009 85)"
  paper-200: "oklch(0.945 0.012 84)"
  paper-300: "oklch(0.906 0.014 83)"
  sumi-900: "oklch(0.205 0.014 62)"
  sumi-800: "oklch(0.285 0.014 62)"
  sumi-600: "oklch(0.44 0.012 65)"
  sumi-500: "oklch(0.545 0.010 68)"
  rule: "oklch(0.855 0.012 82)"
  rule-strong: "oklch(0.60 0.016 78)"
  ok-ink: "oklch(0.46 0.13 155)"
  warn-ink: "oklch(0.50 0.12 70)"
  danger-ink: "oklch(0.49 0.19 25)"
  ink-950: "oklch(0.16 0.008 265)"
  ink-900: "oklch(0.19 0.009 265)"
  ink-850: "oklch(0.22 0.010 265)"
  ink-800: "oklch(0.26 0.011 265)"
  ink-700: "oklch(0.34 0.012 265)"
  ink-500: "oklch(0.55 0.014 265)"
  ink-300: "oklch(0.74 0.012 265)"
  ink-100: "oklch(0.93 0.006 265)"
  accent: "oklch(0.72 0.14 195)"
  accent-dim: "oklch(0.52 0.10 195)"
  ok: "oklch(0.74 0.15 155)"
  warn: "oklch(0.78 0.15 78)"
  danger: "oklch(0.66 0.18 25)"
typography:
  display:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "clamp(2.25rem, 7vw, 3.5rem)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.75rem, 5vw, 2.5rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.125rem, 3vw, 1.375rem)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  section:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "tabular-nums lining-nums"
  subhead:
    fontFamily: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Public Sans Variable', system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  action:
    fontFamily: "'Public Sans Variable', system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  secondary:
    fontFamily: "'Public Sans Variable', system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "'Public Sans Variable', system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.09em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
    fontSize: "12px"
rounded:
  none: "0px"
  bar: "3px"
  thumb: "5px"
spacing:
  row: "10px"
  band: "24px"
  section: "56px"
  chapter: "64px"
components:
  button-primary:
    backgroundColor: "{colors.sumi-900}"
    textColor: "{colors.paper-50}"
    rounded: "{rounded.none}"
    padding: "10px 24px"
  button-primary-hover:
    backgroundColor: "{colors.sumi-800}"
    textColor: "{colors.paper-50}"
  button-primary-disabled:
    backgroundColor: "{colors.paper-200}"
    textColor: "{colors.sumi-500}"
  button-secondary:
    backgroundColor: "{colors.paper-50}"
    textColor: "{colors.sumi-900}"
    rounded: "{rounded.none}"
    padding: "10px 24px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-200}"
    textColor: "{colors.sumi-900}"
  composer:
    backgroundColor: "{colors.paper-50}"
    textColor: "{colors.sumi-900}"
    typography: "{typography.title}"
    rounded: "{rounded.none}"
    padding: "4px 0"
  ruled-row:
    backgroundColor: "{colors.paper-50}"
    textColor: "{colors.sumi-900}"
    rounded: "{rounded.none}"
    padding: "10px 0"
  margin-rail:
    backgroundColor: "{colors.paper-50}"
    textColor: "{colors.sumi-600}"
    typography: "{typography.mono}"
    padding: "0 0 0 20px"
    width: "13.5rem"
---

# Design System: kakeibo

## Overview

**Creative North Star: "The Household Account Book and the Machine Room"**

kakeibo is a 家計簿 — a Japanese household account book — and the product
surfaces are built as one: warm paper, sumi ink, and ruled hairlines, with the
page divided by lines rather than by boxes. The engineering is the product, so
the machinery is never hidden, but it is set the way an account book sets
arithmetic: the narrative in the wide column, the entries posted in the margin
beside it, the figures aligned so a column can be read down.

The site has two grounds, not one theme with two modes. The visitor's surfaces
(`/`, `/chat`, `/dashboard`, `/evals`) are paper. The machine's own record
(`/runs`, `/admin`) keeps the dark monospace terminal it was born in, because a
trace is a machine writing to itself and monospace on black is the right
register for reading one. Crossing between them flips the ground completely and
keeps one navigation bar, so the change reads as walking into another room of
the same building rather than as arriving at a different site.

The paper world has **no chromatic accent at all**. Emphasis is carried by
weight, scale, and the rules themselves, which is what leaves colour free to
mean something: an amber word on this site always marks a write, an overrun, or
an anomaly, and it reads as a signal precisely because nothing decorative is
competing with it. The visual anti-references are explicit and confirmed: no
cards, no tiled grid-paper texture, no entrance animation on content.

**Key Characteristics:**

- Rules, not cards — a section is a ruled band, not a box
- No accent colour; colour appears only where it carries meaning
- Serif for figures and headings, sans for prose, mono only for code and IDs
- Tabular numerals everywhere an amount appears
- Square corners; the only radii are a bar's cap and the scrollbar thumb
- Two grounds with a hard seam and one shared nav

## Colors

A warm, low-chroma paper ramp at hue ~85 under a warm-black sumi ink, with a
second, cooler ramp reserved for the machine room and three status inks that are
the only chroma the product surfaces ever spend.

### Primary

- **Sumi Ink** (`oklch(0.205 0.014 62)`): the ink of the product world — body
  text, headings, figures, the primary button's fill, and the heavy rule under a
  section heading. It is a warm black, never a neutral one: ground charcoal in
  animal glue reads brown-black on paper, and a pure neutral black on warm paper
  looks like a hole punched in it. Measured at **17.2:1** on paper.
- **Sumi Muted** (`oklch(0.44 0.012 65)`): secondary prose — the sentence under a
  heading, a section's explanatory note. **4.8:1** on paper, so it clears body
  text contrast rather than sitting just under it.
- **Sumi Faint** (`oklch(0.545 0.010 68)`): labels, units, counts, and anything
  the eye should pass over on the way to a figure.

### Secondary

There is no secondary accent, and that absence is the system's load-bearing
decision rather than an omission. See **The No Accent Rule** below.

### Tertiary

Three status inks, darkened until each clears 4.5:1 on paper (measured between
**5.9:1** and **6.7:1**). They exist to mark states, never to decorate.

- **Warn Ink** (`oklch(0.50 0.12 70)`): a pending or proposed write, an anomaly,
  a context eviction, a paused session.
- **Danger Ink** (`oklch(0.49 0.19 25)`): a budget overrun, a failed tool call, a
  failing eval class.
- **OK Ink** (`oklch(0.46 0.13 155)`): money that came back. Deliberately rare —
  it is *not* used to confirm that something worked.

### Neutral

- **Paper** (`oklch(0.985 0.006 85)`): the ground of every product surface. Not
  magazine cream; closer to a manila ledger sheet, warm enough to hold a printed
  hairline.
- **Paper Shade** (`oklch(0.945 0.012 84)`): the secondary button's hover, the
  track behind a budget meter, a disabled fill.
- **Rule** (`oklch(0.855 0.012 82)`): the hairline between rows. Measured at
  **1.5:1** and deliberately below the contrast threshold: it is a row
  separator, and it must not compete with the figures sitting on it.
- **Rule Strong** (`oklch(0.60 0.016 78)`): chart baselines, table heads, the
  composer's writing line, and the target mark on a budget meter. **3.79:1** —
  moved above 3:1 on purpose, because WCAG 1.4.11 treats a graphic required to
  understand content as a contrast obligation. `L 0.74` measured 2.2:1 and was
  rejected.

### The machine room

The cool `ink-*` ramp at hue 265 with a cyan accent (`oklch(0.72 0.14 195)`)
belongs to `/runs` and `/admin` only. It is the incumbent terminal palette,
unchanged, and the product surfaces never borrow from it.

### Named Rules

**The No Accent Rule.** The paper world has no brand accent. Emphasis comes from
weight, scale, and the rules. Colour appears only where it carries meaning — a
write, an overrun, an anomaly, an error — and never to confirm that something is
fine. Adding "just one accent" later does not add a colour; it removes the
reason the status inks read as signals.

**The Nothing-Is-Green-When-It-Is-Fine Rule.** A pass rate of 100%, a clean
class, a successful call: all of these are ink. A wall of green costs the page
the one thing that makes a failure leap off it. Only a shortfall takes a tone.

**The Two Grounds Rule.** Each route group's layout paints its own full-height
ground via `[data-genre]`. `body` owns neither. A surface never mixes the two
palettes, and the seam between them is a hard cut, not a gradient.

## Typography

**Display Font:** Source Serif 4 Variable (with Georgia, Times New Roman)
**Body Font:** Public Sans Variable (with system-ui, -apple-system)
**Label/Mono Font:** ui-monospace / SF Mono / JetBrains Mono / Menlo

**Character:** A transitional serif with real wedge terminals against a plain,
wide-aperture grotesque. The serif carries anything that is *stated* — headings,
questions, and every figure — and the sans carries anything that is *explained*.
That split is what lets a page with no colour still have two voices. Both faces
are self-hosted variable fonts.

### Hierarchy

- **Display** (400, `clamp(2.25rem, 7vw, 3.5rem)`, 1.04, -0.03em): one per page,
  the largest type on the site. The landing's thesis line.
- **Headline** (400, `clamp(1.75rem, 5vw, 2.5rem)`, 1.1, -0.025em): a page title
  — `Evals`, a dashboard month.
- **Title** (400, `clamp(1.125rem, 3vw, 1.375rem)`, 1.35, -0.01em): a visitor's
  question, set as the heading of its own entry. Also the composer's input.
- **Section** (600, 19px, -0.01em, serif): a section heading sitting *on* its
  rule, not above a box.
- **Subhead** (600, 17px, -0.01em, serif): a heading *inside* a ruled band — the
  confirmation slip, the landing's gate note. Subordinate to Section, which is
  why it is a step rather than the same one.
- **Figure** (400, 30px, 1, -0.02em, serif, tabular): a headline amount or count.
  Figures are serif because the serif is the book's own voice for numbers.
- **Body** (400, 15px, 1.7, max 68ch): prose, answers, explanation.
- **Action** (400, 14px): every button, primary and secondary, and any link
  acting as one. It is the only step that exists to be clicked, which is why it
  sits between body and secondary rather than matching either.
- **Secondary** (400, 13px): the sentence under a heading, a row's supporting
  detail.
- **Label** (400, 11–12px, 0.08–0.11em, uppercase): column heads, units, tiers,
  status words.
- **Mono** (12px): tool names, task ids, code, and every character of the
  terminal genre.

### Named Rules

**The Tabular Figure Rule.** Every amount carries `.num`
(`tabular-nums lining-nums`) and is set in the serif on paper, in the mono in the
terminal. A ledger whose columns do not line up reads as untrustworthy no matter
how correct it is. This rule predates the visual system and outlives it.

**The Mono-Is-Not-A-Costume Rule.** Monospace marks code, identifiers, and
machine output — tool names, task ids, run ids, the whole terminal genre. It is
never used to make a product surface look technical.

**The Measure Rule.** Prose is capped at 68ch, a section note at 70ch, a heading
at 16–19ch. A line of body text that runs the width of a 1440px viewport is not
a paper page.

## Layout

Product surfaces sit in a centred column, `max-w-5xl` with `24px` gutters; the
terminal genre uses `max-w-6xl` and tighter padding, because dense machine output
earns the extra width.

The recurring spatial idea is the **ledger spread**: a wide column for the thing
being said and a `13.5rem` margin rail for what it cost, separated by a vertical
hairline. It collapses to a single column below `lg`, where the rail moves *under*
its content with a horizontal rule above it instead of a vertical one beside it.
`/chat`, the landing's recorded exchange, the landing's provenance block, and the
`/evals` run summary are all the same spread.

Vertical rhythm is set by ruled bands rather than by cards: a section is `56px`
of space, a top rule, its heading on that rule, and its rows beneath at `10px`
of padding each. There is more space above a heading than below it. Sections
separate at `56–64px`.

Responsive behaviour is where a ruled layout actually fails, and two rules come
out of that:

- **A row of fixed columns is a desktop idea.** Below `sm`, rows with three or
  more fixed-width columns re-place their cells explicitly — the name or
  description takes the full width, the two figures share the first line aligned
  to the outer rules, and repeated constants drop to a second line. Cells are
  placed by explicit `col-start` / `row-start`, never by `order` utilities on an
  auto-placed grid, which is how the amount ended up aligned to nothing.
- **A wide table becomes a list.** A six-column table needs `42rem`; below `sm`
  the same rows render as ruled entries with the identifier and verdict on the
  first line and the figures beneath. A horizontal scroller inside a vertically
  scrolling page is a control most readers never find.

## Elevation & Depth

**There are no shadows anywhere in this system, on either ground.** Depth is not
part of the metaphor: paper is flat, and an account book has no floating
elements. Hierarchy is carried entirely by rule weight, type scale, and space.

The rule weights *are* the depth system:

- **Hairline** (`1px`, Rule): between rows in a list.
- **Structural** (`1px`, Rule Strong): a table head, a chart baseline, the top of
  a column of figures.
- **Heavy** (`1px`, Sumi): under a section heading — the strongest horizontal
  division a page normally uses.
- **Slip** (`2px`, Sumi, top and bottom): the write-confirmation gate, the one
  element allowed to rule off on both sides and interrupt the page.
- **Double** (`4px double`, Sumi): a total. In accounting a double underline means
  "this is final", and the mark itself is built on it, so it is spent only on a
  closing figure.

### Named Rules

**The Flat Rule.** No `box-shadow` on any surface, in any state. A hover changes
a fill or a rule's colour; it never lifts anything.

## Shapes

**Square by default.** Buttons, inputs, slips, tables and rows have no radius at
all — `0px` is the system value, not an oversight. There are exactly two
exceptions, both on drawn marks rather than on containers: the cap of a
horizontal bar (`3px`, trailing edge only), which reads as ink laid down with a
pen rather than as a rounded rectangle, and the scrollbar thumb (`5px` on a 10px
track, so a full pill) in both genres, where the platform convention is stronger
than the house style and fighting it makes the page feel broken rather than
considered.

There are no containers. The form language is entirely lines: horizontal rules
divide, a single vertical hairline separates the ledger spread's two columns,
and a `2px` band top and bottom marks the one element that interrupts the page.

The 家計簿 mark is the system's only drawn shape: one cell of a ledger grid,
ruled into a wide description column and a narrow amount column, with the
accountant's double rule struck under the amount. Every stroke is
`currentColor`, so one mark serves both grounds.

### Named Rules

**The Rules-Not-Cards Rule.** There are no cards in a 家計簿. A grouping is a
ruled band with its heading sitting on the rule. Nothing on a product surface
draws a border on all four sides, and nested containers do not exist.

## Components

### Buttons

- **Shape:** square (`0px`), no border radius in any variant.
- **Primary:** sumi fill, paper text, `10px 24px`. The only filled element on a
  product surface, which is what makes it read as the action.
- **Hover / Focus:** fill lightens to Sumi 800 on a colour transition; keyboard
  focus takes the genre's `2px` sumi outline at `2px` offset.
- **Disabled:** pale paper fill with faint sumi text — a light control that reads
  as inactive. Never a dimmed dark fill: paper text on Rule Strong measures
  3.4:1, which is a label you have to lean in to read.
- **Secondary:** `1px` sumi outline, sumi text, transparent fill; hover fills to
  Paper Shade. Used beside the primary, never alone.

### Cards / Containers

None. See **The Rules-Not-Cards Rule**. The nearest thing is a ruled band: a
`1px` sumi rule, a serif heading sitting on it, an optional note beneath, and
rows separated by hairlines.

### Inputs / Fields

- **Style:** no box. The composer is a `2px` Rule Strong writing line under a
  borderless, transparent field set in the serif at title size — the blank line
  at the foot of a ledger page.
- **Focus:** the writing line darkens from Rule Strong to Sumi. The width does
  not change, so nothing shifts; the browser outline is suppressed only because
  the rule itself is the indicator.
- **Disabled:** the field dims to 50%.

### Navigation

One bar across both genres, carrying no colours of its own — every value is
inherited from the `[data-genre]` wrapper, which is what makes the ground flip
read as a crossing rather than as a different site. Sticky, with a
`currentColor/12` bottom rule and a backdrop blur. The active link is full
opacity with a `1px` underline of `currentColor`; the rest sit at 50% and lift to
80% on hover. Below `sm` the kanji is hidden and the links scroll horizontally
with the scrollbar suppressed, because a truncated last link is worse than a
scrolled one.

### The Ledger Spread (signature)

The system's defining component, shared by the live agent page and by the
landing's recorded demo so the two cannot drift apart.

- **Question:** a `1px` sumi rule, then the question as a serif heading sitting
  on it.
- **Prose column:** the answer at body size, capped at 68ch.
- **Margin rail:** `13.5rem`, separated by a vertical hairline, headed by a
  `0.11em`-tracked uppercase label. Each posted entry is a hairline-separated row
  carrying the tool name, its arguments glossed to one line, and what came back.
  A write is marked with an amber `write`; a write held at the gate reads
  `awaiting your decision` and is the one entry allowed to wrap.
- **Turn account:** below a `1px` sumi rule, a column of label/figure pairs —
  elapsed, tokens in with the cached percentage, tokens out, cost — and a link to
  the full trace.

### The Confirmation Slip (signature)

The write gate. A `2px` sumi rule top and bottom, spanning both columns of the
spread, because the turn has genuinely stopped and the loop is suspended in the
database waiting on the answer. It carries a serif heading in the visitor's terms
("This will change your ledger"), the tool's own one-line summary, a ruled table
of the literal arguments, and two buttons. Money in the argument table shows the
formatted amount first and the integer minor units beside it.

**One slip per suspended turn, not per write.** A turn can propose several
writes at once, and the loop suspends on the batch as a whole: the provider
requires every call in a turn to be answered together, and the resume deletes
the suspended row as it reads it. So the slip lists each proposed write with its
own arguments under a `rule-strong` division and carries a single Allow / Decline
pair reading "Allow all" when there is more than one. Rendering a pair of buttons
per write offered a granularity the loop could not honour, and the page did
exactly that until 2026-08-14: answering one write declined the others by
omission, without showing them as declined.

**The slip states an outcome only once the server has taken the decision.**
Between the click and the response it reads "Sending your decision…", and a
refusal returns it to pending rather than leaving it claiming a write that never
ran. It is the one component on the site whose whole job is to be believed about
the ledger.

### The Social Card (signature)

`opengraph-image.jpg`, 1200×630, and the only place in the system where a
generated image appears. PRODUCT.md says the visitor arrives from a CV, a README
or a link in a message, which makes the link preview the first impression the
site gets to make.

It is a sheet of ledger paper — generated with Imagen 4 Ultra, warmer than
`paper-50` and lifted toward it with a translucent wash — carrying the real
wordmark, the display line, and four measured figures over a `1.5px` sumi rule.
The paper's own printed column rules line up with the layout's right edge, which
is the whole reason a generated plate beats a flat fill here.

**The Model Makes Material, Never Lettering Rule.** Every glyph on the card is
composited in the real Source Serif 4 by the browser. A model rendering type
produces letterforms that are almost right, and almost right on a wordmark is
worse than no image at all. Generate paper, ink, and texture; set type yourself.

### Named Rules

**The Same-Component Rule.** The landing's recorded demo is built from the exact
components the live page uses. If the demo drew its own rules, the first thing a
visitor would notice on reaching `/chat` is that the demo was a different
product.

## Do's and Don'ts

### Do:

- **Do** divide with rules. A grouping is a `1px` sumi rule with its heading
  sitting on it.
- **Do** give every amount `.num` and align it to a column.
- **Do** spend colour only on a write, an overrun, an anomaly, or an error — and
  always with a word beside it, never colour alone.
- **Do** re-place cells explicitly with `col-start` / `row-start` at narrow
  widths, and check that the figure still hangs on the row's right rule.
- **Do** set the serif for anything stated (headings, questions, figures) and the
  sans for anything explained.
- **Do** put the source of a figure next to it. Every number on a product surface
  is read from `evals/report/latest.json`, counted off the tool registry, or
  computed by the same repository function the agent's tools call.
- **Do** use the double rule (`4px double`) for a total, and only for a total.

### Don't:

- **Don't** add an accent colour. See **The No Accent Rule**.
- **Don't** draw a card, a panel, or any four-sided border on a product surface.
- **Don't** add a `box-shadow`. The system is flat on both grounds.
- **Don't** round a corner. Square is the system value; the only radius is a
  `3px` bar cap.
- **Don't** reintroduce a tiled 方眼 grid-paper background. One shipped, unused,
  with a comment claiming it did structural work; nothing ever aligned to it, and
  a tiled hairline field is one of the more reliable tells of a machine-made
  interface. If a surface ever genuinely sets figures on a 24px grid, bring it
  back then, with the alignment that earns it.
- **Don't** animate content into existence. An entrance reveal here started rows
  at `opacity: 0`, so printing, an in-page find, or a deep link mid-document
  showed a page with a hole in it. Animate from an already-visible default. The
  motion this product has is real: the margin entries post one at a time as the
  agent calls each tool, driven by the stream.
- **Don't** colour a success. A green pass rate costs the page the contrast that
  makes a failure visible.
- **Don't** mix the two grounds on one surface, and don't soften the seam between
  them.
- **Don't** print a truncated machine payload as if it were a summary. Say
  something derived from it, or say nothing.
- **Don't** print raw minor units in front of a person. Tool results name their
  units in paise and that is correct on the wire; money is formatted at the
  display boundary, and the boundary is the component.
- **Don't** let a model render type. It generates material — paper, ink,
  texture; the browser sets the lettering in the real face.
- **Don't** put a decorative image on a product surface. The one generated asset
  in this system is the social card, which never appears on a page.
