import { useCallback, useId, useRef, useState } from 'react'

interface DropzoneProps {
  onFile: (file: File) => void
  disabled?: boolean
  /** Rendered under the button — a hint about what to drop. */
  hint?: string
}

/**
 * Modern file picker that also accepts drag-and-drop and paste.
 *
 * `capture="environment"` makes the file input open the rear camera directly on
 * mobile devices for quick receipt scanning.
 */
export function Dropzone({ onFile, disabled = false, hint }: DropzoneProps) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const dragDepth = useRef(0)

  const accept = useCallback(
    (files: FileList | null | undefined) => {
      const file = files?.[0]
      if (!file) return
      if (!file.type.startsWith('image/')) return
      onFile(file)
    },
    [onFile],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (disabled) return
      accept(event.dataTransfer?.files)
    },
    [accept, disabled],
  )

  return (
    <div
      className={`dropzone${dragging ? ' dropzone--active' : ''}${disabled ? ' dropzone--disabled' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        if (!disabled) setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
      onPaste={(e) => {
        if (disabled) return
        accept(e.clipboardData?.files)
      }}
    >
      <div className="dropzone__icon-wrap">
        <svg
          className="dropzone__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
          <path d="M12 12v9" />
          <path d="m16 16-4-4-4 4" />
        </svg>
      </div>

      <div className="dropzone__content">
        <label className="btn btn--primary dropzone__btn" htmlFor={inputId}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Choose a ticket photo
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="dropzone__input"
          type="file"
          accept="image/*"
          capture="environment"
          disabled={disabled}
          onChange={(e) => {
            accept(e.target.files)
            e.target.value = ''
          }}
        />
        <p className="dropzone__hint">
          {hint ?? 'Drag and drop, or paste image from clipboard'}
        </p>
      </div>
    </div>
  )
}
