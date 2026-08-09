# PRODUCT.md — kakeibo

Product truth. Visual decisions live in DESIGN.md; this file is what is true
regardless of how it looks.

## What it is

A personal finance agent built from scratch on the raw Gemini API — no agent
framework, no SDK tool-runner. It imports bank-statement CSVs into a
double-entry PostgreSQL ledger and answers questions about them across turns:
what you spent, what you are subscribed to, what looks wrong, what you should
budget.

**The unique mechanism:** the agent loop is hand-written and legible — twelve
tools, a confirm-before-write gate that suspends the turn and resumes it in a
different process, context caching, a prompt-injection suite, and a trace of
every model and tool call. The engineering is the product.

## Who it is for, and what success looks like

The visitor is **someone evaluating the engineering** — an engineer, a hiring
manager, a peer reading the README. Not a person managing their money.

Success is that visitor asking the agent a real question about a real ledger
within seconds of landing, seeing the machinery work, and being able to open the
trace behind the answer.

This is explicitly **a playable portfolio piece, not a finance product**.
Importing your own statement exists, works, and is deliberately secondary.

## The real scene

Read on a laptop, usually in a tab opened from a CV, a README or a link in a
message. Attention is short and sceptical: the visitor has seen many chat demos
and assumes this is another one. Rarely on a phone, but it must not be broken
there.

## Constraints that shape everything

- **A $20/month model ceiling on a personal card.** Roughly 148 live turns a
  day. Past the cap the site falls back to replaying a recorded conversation.
  Generosity is not available; honesty about the limit is.
- **Every visitor gets their own synthetic ledger**, cloned on first use. Real
  statement upload exists, is open to everyone, and is deleted after 24 hours.
- **Two audiences on one site.** The product surfaces are for the visitor; the
  trace viewer and `/admin` are for the operator. They are deliberately
  different genres and must not be homogenised.

## Brand commitments

- **家計簿** (kakeibo) is a Japanese household account book. The name is the
  governing fact, not decoration.
- Money is displayed in integer minor units converted at the display boundary;
  figures must use tabular numerals and align in columns. A ledger whose columns
  do not line up reads as untrustworthy no matter how correct it is.
- Numbers in the README are reproducible by a script in the repo. The site
  inherits that rule: no invented metrics anywhere in the UI.

## Content that is real, and content that is synthetic

Real: the tool list, the trace data, the eval report, the injection results, the
architecture. All of it comes out of the repo or the database.

Synthetic and must be labelled as such: the 352-transaction seed ledger every
visitor gets. It is generated, not anyone's real spending.

Uninventable: model costs, latency figures, pass rates, and any claim about what
the system can do. These come from `pnpm metrics` or they do not appear.

## Out of scope

Bring-your-own-key. Paid tiers. Live bank connections. Real FX. A mobile app.
Anything that turns this into a financial service rather than a demonstration
of one.
