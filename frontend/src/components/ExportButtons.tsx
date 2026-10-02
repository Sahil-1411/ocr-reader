/** The buttons every export row is made of. */

import { useState } from 'react'

import { copyText } from '../lib/download'

export function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

/**
 * The copy button, which says so for a moment after it has copied.
 *
 * `text` may be a function, and then it is called on the click rather than
 * before it: what this copies is fetched from the reader, and fetching it
 * against a button nobody presses is a round trip for nothing.
 */
export function CopyButton({ text, label, title, disabled }: {
  text: string | (() => Promise<string>)
  /** What the button copies, for the label it shows at rest. */
  label: string
  title?: string
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const value = typeof text === 'function' ? await text() : text
    await copyText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <button
      type="button"
      className={`btn btn--sm${copied ? ' btn--copied' : ''}`}
      onClick={copy}
      disabled={disabled}
      title={title ?? label}
    >
      {copied ? (
        <>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}
