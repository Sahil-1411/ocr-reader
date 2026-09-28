import { STAGE_NAMES, type StageName } from '../ocr/types'
import type { StageMap } from '../lib/stage-state'

export interface StageProgressProps {
  stages: StageMap
  running: boolean
}

const LABELS: Record<StageName, string> = {
  init: 'init',
  decode: 'decode',
  perspective: 'perspective',
  deskew: 'deskew',
  watermark: 'watermark',
  binarize: 'binarize',
  detect: 'detect',
  recognize: 'recognize',
  cluster: 'cluster',
  assemble: 'assemble',
}

export function StageProgress({ stages, running }: StageProgressProps) {
  const settled = STAGE_NAMES.filter((s) => {
    const status = stages[s]?.status
    return status === 'done' || status === 'skip'
  }).length
  const percent = Math.round((settled / STAGE_NAMES.length) * 100)

  return (
    <div className="progress">
      <div
        className="progress__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="OCR pipeline progress"
      >
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>

      <div className="stages">
        {STAGE_NAMES.map((stage) => {
          const state = stages[stage]
          if (!state && !running) return null
          const status = state?.status ?? 'start'
          return (
            <span
              key={stage}
              className={`stage-chip stage-chip--${status}`}
              title={state?.message ?? LABELS[stage]}
            >
              {LABELS[stage]}
              {state?.elapsedMs !== undefined && (
                <span className="stage-chip__ms">{Math.round(state.elapsedMs)}ms</span>
              )}
            </span>
          )
        })}
      </div>

      {Object.entries(stages)
        .filter(([, s]) => s?.status === 'skip' && s.message)
        .map(([stage, s]) => (
          <p key={stage} className="dropzone__hint" style={{ textAlign: 'left' }}>
            <strong>{LABELS[stage as StageName]}</strong> skipped — {s!.message}
          </p>
        ))}
    </div>
  )
}
