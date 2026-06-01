/**
 * Rough token estimation for budget enforcement.
 *
 * Uses ~4 chars/token for English text. Good enough for budget gates
 * without pulling in tiktoken.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.role)
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content)
    } else if (m.content != null) {
      total += estimateTokens(JSON.stringify(m.content))
    }
  }
  return total
}
