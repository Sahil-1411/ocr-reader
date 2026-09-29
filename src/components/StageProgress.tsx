import { STAGE_NAMES } from '../ocr/types'
import type { StageMap } from '../lib/stage-state'

interface StageProgressProps {
  stages: StageMap
}

export function StageProgress({ stages }: StageProgressProps) {
  const settled = STAGE_NAMES.filter((s) => {
    const status = stages[s]?.status
    return status === 'done' || status === 'skip'
  }).length
  const percent = Math.round((settled / STAGE_NAMES.length) * 100)

  return (
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
  )
}
