// Global, app-wide enable/disable state for the agent's capabilities, kept in a
// hand-editable `tool-toggles.json` next to the skills dir under userData. MCP
// servers are toggled through their own config (see `mcp.ts` / mcp.setEnabled),
// so only built-in tool groups and skills live here. A name absent from the
// disabled lists is enabled by default — disabling is opt-in.
import { z } from 'zod'

export const ToolTogglesSchema = z.object({
  /** Skill names hidden from the catalog and refused by use_skill. */
  disabledSkills: z.array(z.string()).default([]),
  /** Built-in tool groups (fs, web, peekaboo, memory, skill, …) removed from every agent. */
  disabledToolGroups: z.array(z.string()).default([]),
})
export type ToolToggles = z.infer<typeof ToolTogglesSchema>

/** A built-in tool group surfaced to the toggle UI, with its current enabled state. */
export type ToolGroupInfo = {
  group: string
  /** Bare tool names in the group, for the UI to show what disabling removes. */
  toolNames: string[]
  enabled: boolean
}
