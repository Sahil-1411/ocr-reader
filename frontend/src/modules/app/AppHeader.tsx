import type { ReactNode } from 'react'

import { useTheme, type ThemePreference } from '../../lib/theme'

const THEMES: { value: ThemePreference; label: string; icon: 'monitor' | 'sun' | 'moon' }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]

function ThemeIcon({ icon }: { icon: 'monitor' | 'sun' | 'moon' }) {
  switch (icon) {
    case 'sun':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      )
    case 'moon':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )
    case 'monitor':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )
    default: {
      const unreachable: never = icon
      return unreachable
    }
  }
}

interface AppHeaderProps {
  /**
   * What the read amounts to, shown beside the title: the row count and the
   * skipped chip. Present only once a document has been read.
   */
  status?: ReactNode
  /** The export buttons, which share this one row with the title and theme. */
  actions?: ReactNode
}

/**
 * The one bar across the top: the title, what has been read, what can be done
 * with it, and the theme switch.
 *
 * A document's actions belong in the same row as its title rather than in a
 * second strip below it — the window is for reading rows, and a header that
 * grows every time there is more to say about the read takes that room away.
 */
export function AppHeader({ status, actions }: AppHeaderProps) {
  const [theme, setTheme] = useTheme()
  const docked = status !== undefined || actions !== undefined

  return (
    <header className={`app__header${docked ? ' app__header--docked' : ''}`}>
      <div className="app__brand">
        <div className="app__logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 3h16a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2-3-2-2 2V4a1 1 0 0 1 1-1Z" />
            <path d="M8 8h8" />
            <path d="M8 12h8" />
            <path d="M8 16h4" />
          </svg>
        </div>
        <div>
          <div className="app__title-row">
            <h1 className="app__title">Receipt OCR</h1>
          </div>
          <p className="app__subtitle">Instant lottery and receipt reader.</p>
        </div>
      </div>

      {docked && (
        <div className="app__dock">
          {status !== undefined && <div className="app__status">{status}</div>}
          {actions !== undefined && <div className="btn-row app__actions">{actions}</div>}
        </div>
      )}

      <div className="app__controls">
        <div className="segmented" role="group" aria-label="Theme selector">
          {THEMES.map(({ value, label, icon }) => (
            <button
              key={value}
              type="button"
              className={`segmented__option${theme === value ? ' segmented__option--active' : ''}`}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <ThemeIcon icon={icon} />
              <span className="segmented__label">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
