/**
 * Handing something to the browser: the clipboard and the downloads.
 *
 * No React here, so the export buttons and anything else that offers a file
 * share one copy of the quirks.
 */

/** Copy `text`, falling back to a hidden textarea where the clipboard is blocked. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/** Offer `content` to the browser as a download. */
export function saveFile(content: string, type: string, name: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The uploaded file's name without its extension, for the downloads. */
export function exportBaseName(fileName: string | null, fallback: string): string {
  return (fileName ?? '').replace(/\.[^.]+$/, '') || fallback
}
