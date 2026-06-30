import { describe, expect, it } from 'vitest'

import { DEFAULT_SYSTEM_PROMPT } from './default-prompt'

describe('DEFAULT_SYSTEM_PROMPT loop-aware section', () => {
  it('documents the autonomous-operation conventions', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Autonomous operation')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('schedule_task')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('wait_for_task')
    // Ending the turn is "done" — no busy-loop instruction.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('end your turn')
    // The render_ui tool blurb advertises the document-preview card types.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('"pdf" | "docx" | "xlsx" | "csv"')
  })
})
