import { cn } from '@/lib/cn'

/**
 * The 家計簿 mark.
 *
 * Drawn rather than generated, and drawn in the world's own grammar: it is one
 * cell of the 方眼 grid the paper genre is built on, ruled off into a wide
 * description column and a narrow amount column, with the accountant's double
 * rule struck under the amount. A double underline means "this is the final
 * total" in every account book ever kept by hand, which makes it the one mark
 * that says *ledger* without drawing a coin, a chart or a wallet.
 *
 * Every stroke is `currentColor`, so the same mark is sumi on paper in the
 * product genre and phosphor on black in the machine room — the seam between
 * the two worlds does not need two logos.
 *
 * Hairlines are specified in user units against a 24-unit box and scale with
 * the glyph, so the mark keeps a printed-rule weight at nav size and at
 * statement-head size instead of turning into a smudge at one end or a frame at
 * the other.
 */
export function Glyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('h-[1em] w-[1em]', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      {/* The cell. */}
      <rect x="2.5" y="2.5" width="19" height="19" />
      {/* The rule that divides description from amount. */}
      <path d="M14.5 2.5 V21.5" />
      {/* Two entries posted in the description column. */}
      <path d="M5.5 9 H11.5 M5.5 13 H11.5" opacity={0.55} />
      {/* The double rule: the amount column, totalled. */}
      <path d="M16.5 15.5 H19.5 M16.5 18 H19.5" />
    </svg>
  )
}

/**
 * The wordmark: the mark, the name, and the name it is named after.
 *
 * The kanji is not decoration and not a translation gloss — 家計簿 *is* the
 * product's governing fact (PRODUCT.md), so it is set at reading size beside
 * the latin rather than shrunk into a superscript.
 */
export function Wordmark({
  className,
  showKanji = true,
}: {
  className?: string
  showKanji?: boolean
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-2.5', className)}>
      <Glyph className="translate-y-[0.08em] opacity-90" />
      <span className="font-serif font-semibold tracking-[-0.015em]">kakeibo</span>
      {/*
       * Hidden below `sm`, not dropped. Three kanji next to five nav links on a
       * 390px screen forced the characters to wrap into a vertical stack, which
       * is a worse way to honour the name than leaving it to the wider layouts
       * where it can sit on the baseline as it is meant to.
       */}
      {showKanji ? (
        <span className="hidden text-[0.62em] tracking-[0.08em] opacity-50 sm:inline">家計簿</span>
      ) : null}
    </span>
  )
}
