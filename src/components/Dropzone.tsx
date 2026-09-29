import { useCallback, useId, useRef, useState } from 'react'

interface DropzoneProps {
  onFile: (file: File) => void
  disabled?: boolean
  /** Rendered under the button — a hint about what to drop. */
  hint?: string
}

/**
 * File picker that also accepts drag-and-drop and paste.
 *
 * `capture="environment"` makes the file input open the rear camera directly on
 * a phone, which is how most people will actually use this: point at the ticket,
 * shoot, read. On desktop the attribute is ignored and it behaves as a normal
 * picker.
 */
export function Dropzone({ onFile, disabled = false, hint }: DropzoneProps) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  // Nested dragenter/dragleave pairs fire for every child element; counting them
  // is the only reliable way to know when the pointer has truly left.
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
      className={`dropzone${dragging ? ' dropzone--active' : ''}`}
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
      <label className="btn btn--primary" htmlFor={inputId}>
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
          // Reset so picking the same file twice still fires a change event.
          e.target.value = ''
        }}
      />
      <p className="dropzone__hint">{hint ?? 'or drag, drop, or paste an image here'}</p>
    </div>
  )
}
