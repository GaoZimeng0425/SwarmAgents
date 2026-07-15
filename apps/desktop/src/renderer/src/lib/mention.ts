// Pure mention-extraction + skill filtering for the composer autocomplete.
// No React, no I/O — fully unit-testable.
import type { Skill } from '@swarm/protocol'

export type MentionTrigger = '/' | '@'

export type Mention = { trigger: MentionTrigger; query: string; start: number; end: number }

const TRIGGERS = new Set<MentionTrigger>(['/', '@'])

/**
 * Scan left from the caret for a `/` or `@` trigger that sits at a word
 * boundary (start of input or preceded by whitespace). The query is the text
 * from after the trigger up to the caret. Any whitespace inside the query
 * invalidates the mention (returns null) — a closed mention can't be reopened
 * by moving the caret back without re-typing.
 *
 * Returns `{ trigger, query, start, end }` where `start` is the trigger's index
 * and `end` is the caret index (the range to replace on commit).
 */
export function extractMention(value: string, caret: number): Mention | null {
  // Walk left from just before the caret, looking for a trigger.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (/\s/.test(ch)) return null // whitespace before any trigger → no mention
    if (TRIGGERS.has(ch as MentionTrigger)) {
      // Trigger must be at a word boundary: start of input or after whitespace.
      const before = value[i - 1]
      if (i === 0 || /\s/.test(before)) {
        const query = value.slice(i + 1, caret)
        return { trigger: ch as MentionTrigger, query, start: i, end: caret }
      }
      // Trigger is mid-word (e.g. "a/b") — keep scanning left.
    }
  }
  return null
}

/**
 * Keep only skills the model can invoke via use_skill: not hidden from the
 * model list, and not disabled by the user.
 */
export function callableSkills(all: Skill[]): Skill[] {
  return all.filter((s) => !s.disableModelInvocation && s.enabled !== false)
}

/**
 * Case-insensitive substring match on name or description. Name hits rank
 * before description-only hits; ties break alphabetically by name.
 */
export function matchSkills(skills: Skill[], query: string): Skill[] {
  if (!query) return [...skills].sort((a, b) => a.name.localeCompare(b.name))
  const q = query.toLowerCase()
  return skills
    .map((s) => {
      const inName = s.name.toLowerCase().includes(q)
      const inDesc = s.description.toLowerCase().includes(q)
      return { s, score: (inName ? 1 : 0) + (inDesc ? 0.5 : 0) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
}
