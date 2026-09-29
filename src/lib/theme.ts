import { useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // Storage can be blocked (private mode, embedded views); fall back to system.
  }
  return 'system'
}

function apply(preference: ThemePreference): void {
  const dark =
    preference === 'dark' || (preference === 'system' && window.matchMedia(DARK_QUERY).matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/**
 * The user's theme choice, applied to `<html data-theme>`. `index.html` sets the
 * same attribute before first paint so the page never flashes the wrong theme.
 */
export function useTheme(): [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference)

  useEffect(() => {
    apply(preference)
    try {
      if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // Not persisted; the choice still holds for this visit.
    }
    if (preference !== 'system') return
    const media = window.matchMedia(DARK_QUERY)
    const onChange = () => apply('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  return [preference, setPreference]
}
