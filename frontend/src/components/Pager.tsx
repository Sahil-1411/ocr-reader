/** Moving between the pages of a document, wherever the pages are shown. */

interface PagerProps {
  /** 0-based index of the page on screen. */
  current: number
  /** Pages in the document. One page needs no pager. */
  total: number
  onSwitch: (index: number) => void
  /**
   * Sized to sit in a card's title bar beside its other controls, rather than
   * under the thing it pages through.
   */
  compact?: boolean
  /** Named for screen readers, since a window may hold more than one. */
  label?: string
}

function ChevronIcon({ back }: { back?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={back ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
    </svg>
  )
}

export function Pager({ current, total, onSwitch, compact = false, label = 'Pages' }: PagerProps) {
  if (total <= 1) return null

  return (
    <nav className={`pager${compact ? ' pager--compact' : ''}`} aria-label={label}>
      <button
        type="button"
        className="icon-btn"
        disabled={current === 0}
        onClick={() => onSwitch(current - 1)}
        aria-label="Previous page"
        title="Previous page"
      >
        <ChevronIcon back />
      </button>
      <span className="pager__count">
        <span className="pager__current">{current + 1}</span>
        <span className="pager__sep">/</span>
        {total}
      </span>
      <button
        type="button"
        className="icon-btn"
        disabled={current === total - 1}
        onClick={() => onSwitch(current + 1)}
        aria-label="Next page"
        title="Next page"
      >
        <ChevronIcon />
      </button>
    </nav>
  )
}
