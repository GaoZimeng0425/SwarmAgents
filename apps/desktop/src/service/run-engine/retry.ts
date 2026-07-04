// Transient-failure retry + model-chain fallback policy for the run engine.
// Pure decisions live here; the engine (W2) owns the loop, the delays, and the
// transcript restore between attempts.

/** A failed request is retried up to this many EXTRA times per model. */
export const MAX_PROMPT_RETRIES = 10
export const RETRY_DELAY_MS = 5_000

/**
 * Failures where retrying the SAME model is pointless — advance the chain (or
 * give up) immediately instead of burning retries on a dead key, a missing
 * model, or an exhausted quota. Anything not matched (timeouts, 5xx, rate
 * limits, transport resets) is transient and retried in place.
 */
export function isPermanentModelFailure(message: string): boolean {
  return /\b(401|403|404)\b|invalid[\s_-]?api[\s_-]?key|unauthor|authentication|permission denied|model not found|no such model|does not exist|insufficient[\s_-]?quota|billing/i.test(
    message
  )
}

/** Sleep that resolves early if `signal` aborts, so a queued retry never
 *  delays a user cancellation. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type RetryDecision = 'retry-same-model' | 'advance-model' | 'give-up'

export type AttemptContext = {
  /** 0-based attempt index on the current model. */
  attempt: number
  /** Extra attempts allowed per model (total attempts = maxRetries + 1). */
  maxRetries: number
  /** 0-based index of the current model in the fallback chain. */
  modelIdx: number
  chainLength: number
  /** Permanent failures skip the remaining retries on this model. */
  permanent: boolean
}

/** What to do after a FAILED attempt. Deliberate stops (cancel/budget/context/
 *  iterations) never reach this — they terminate the run outright. */
export function decideNextAttempt(c: AttemptContext): RetryDecision {
  const lastAttempt = c.attempt >= c.maxRetries
  const lastModel = c.modelIdx >= c.chainLength - 1
  if (!lastAttempt && !c.permanent) return 'retry-same-model'
  if (!lastModel) return 'advance-model'
  return 'give-up'
}
