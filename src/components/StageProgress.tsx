import { STAGE_NAMES } from '../ocr/types'
import type { StageMap } from '../lib/stage-state'

interface StageProgressProps {
  stages: StageMap
}

const STAGE_LABELS: Record<(typeof STAGE_NAMES)[number], string> = {
  init: 'Engine Ready',
  watermark: 'Clean Image',
  recognize: 'Read OCR',
  assemble: 'Build Rows',
}

export function StageProgress({ stages }: StageProgressProps) {
  const settled = STAGE_NAMES.filter((s) => {
    const status = stages[s]?.status
    return status === 'done' || status === 'skip'
  }).length
  const percent = Math.round((settled / STAGE_NAMES.length) * 100)

  // Find currently active stage (status is 'start')
  const currentStage = STAGE_NAMES.find((s) => stages[s]?.status === 'start')

  return (
    <div className="progress-card">
      <div className="progress-card__header">
        <div className="progress-card__title">
          <span className="spinner-dot" aria-hidden="true" />
          <span>{currentStage ? `Processing: ${STAGE_LABELS[currentStage]}` : 'Reading receipt...'}</span>
        </div>
        <span className="progress-card__percent">{percent}%</span>
      </div>

      <div
        className="progress__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Reading the receipt"
      >
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>

      <div className="progress-steps">
        {STAGE_NAMES.map((stage) => {
          const state = stages[stage]
          const isDone = state?.status === 'done' || state?.status === 'skip'
          const isRunning = state?.status === 'start'

          return (
            <div
              key={stage}
              className={`progress-step${isDone ? ' progress-step--done' : ''}${isRunning ? ' progress-step--active' : ''}`}
            >
              <span className="progress-step__dot">
                {isDone ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : null}
              </span>
              <span className="progress-step__label">{STAGE_LABELS[stage]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
