import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

// Single source of truth for the main process's on-disk paths. Two roots:
//
//   - swarmHome() — ~/.swarm-agents, a user-visible dotfolder (like ~/.claude)
//     for hand-editable assets: skills, agents, mcp-servers.json,
//     tool-toggles.json, hooks.json, and the dev log.
//   - userData — Electron's OS-managed app dir, for encrypted credentials and
//     the DB/memory that users shouldn't hand-edit.
//
// Entries are getters, not eager constants: app.getPath('userData') is only
// valid after app.whenReady(), and swarmHome() mkdirs the dir on access (pino
// needs it to exist before the log file is opened). All call sites here run
// after whenReady().

/** ~/.swarm-agents, created on access. */
export function swarmHome(): string {
  const dir = join(homedir(), '.swarm-agents')
  mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  // ~/.swarm-agents — user-visible, hand-editable.
  log: () => join(swarmHome(), 'swarm-dev.log'),
  skills: () => join(swarmHome(), 'skills'),
  agents: () => join(swarmHome(), 'agents'),
  mcpServers: () => join(swarmHome(), 'mcp-servers.json'),
  // Claude-Code-style hooks: event name → command mapping, hand-edited.
  hooks: () => join(swarmHome(), 'hooks.json'),
  // userData — credentials + DB/memory, not for hand-editing.
  db: () => join(app.getPath('userData'), 'agent-service.db'),
  memory: () => join(app.getPath('userData'), 'agent-memory.json'),
  // Session-markdown exports (the command palette's "export" action). Plain
  // .md files the user opens outside the app, so userData (not swarmHome).
  exports: () => join(app.getPath('userData'), 'exports'),
  providers: () => join(app.getPath('userData'), 'providers.enc'),
  bilibili: () => join(app.getPath('userData'), 'bilibili.bin'),
  bilibiliAnalysis: () => join(app.getPath('userData'), 'bilibili-analysis.json'),
  // Locally retained video cards (soft-delete) and pinned videos.
  bilibiliArchive: () => join(app.getPath('userData'), 'bilibili-archive.json'),
  bilibiliPins: () => join(app.getPath('userData'), 'bilibili-pins.json'),
  // Locally-cached OpenRouter model catalog (public pricing/context data — plain
  // JSON, not a credential). Lets pricing auto-match offline and survive restart.
  openrouterCatalog: () => join(app.getPath('userData'), 'openrouter-catalog.json'),
  webSearch: () => join(app.getPath('userData'), 'web-search.enc'),
  weather: () => join(app.getPath('userData'), 'weather.enc'),
  budgets: () => join(app.getPath('userData'), 'budgets.json'),
  gmail: () => join(app.getPath('userData'), 'gmail.enc'),
  gmailDb: () => join(app.getPath('userData'), 'gmail.db'),
  calendar: () => join(app.getPath('userData'), 'calendar.enc'),
  calendarDb: () => join(app.getPath('userData'), 'calendar.db'),
} as const

/**
 * Materialize the hand-editable subdirs so ~/.swarm-agents is a discoverable
 * drop-in home from first launch — without it the dir is empty until the user
 * saves a skill/agent (builtins live in-memory and are never written to disk).
 * mcp-servers.json is deliberately NOT seeded: its store relies on "file
 * absent" to trigger legacy migration, so an empty seed would suppress it.
 */
export function ensureSwarmDirs(): void {
  mkdirSync(paths.skills(), { recursive: true })
  mkdirSync(paths.agents(), { recursive: true })
}
