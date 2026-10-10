export type Ping = { at: number; ok: boolean; usd: number; note: string }

/** One judge's record in one session: when it first called a handoff, and how the person rated it. */
export type Verdict = {
  firstAt: number
  firstCtx: number
  firstTurn: number
  fired: number
  up: number
  down: number
  missed: number
}

/** One session of the signals-vs-model trial, kept in $.store across sessions. */
export type TrialSession = {
  id: string
  startedAt: number
  endedAt: number
  turns: number
  peakCtx: number
  handoffs: number
  modelCalls: number
  modelUsd: number
  signals: Verdict
  model: Verdict
}

/** Which judge suggests handoffs: both side by side while the trial runs, then the one kept. */
export type Judge = 'trial' | 'signals' | 'model' | 'both'

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      lastTouch: number
      keepUntil: number
      now: number
      ctxTokens: number
      window: number
      baseTokens: number
      lastPing: Ping | null
      isPinging: boolean
      suggested: string
      isHidden: boolean
      sigWhy: string
      modelWhy: string
      voted: string
      judge: Judge
      trial: TrialSession | null
      isTrialDone: boolean
      trialSummary: string[]
    }
  }
}
