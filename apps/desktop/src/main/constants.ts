import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

// Single source of truth for the main process's on-disk paths. Two roots:
//
//   - swarmHome() — ~/.swarm-agents, a user-visible dotfolder (like ~/.claude)
//     for hand-editable assets: skills, agents, mcp-servers.json,
//     tool-toggles.json, hooks.json, and the dev log.
//   - userData — Electron's OS-managed app dir, for plaintext config files and
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
  // userData — plaintext config + DB/memory, not for hand-editing.
  db: () => join(app.getPath('userData'), 'agent-service.db'),
  memory: () => join(app.getPath('userData'), 'agent-memory.json'),
  // Session-markdown exports (the command palette's "export" action). Plain
  // .md files the user opens outside the app, so userData (not swarmHome).
  exports: () => join(app.getPath('userData'), 'exports'),
  // Collected-articles store + repo-research cache (the article store owns its
  // own filename collected-articles.json). userData, not swarmHome, so the
  // service pins a stable dir instead of falling back to tmpdir().
  articles: () => join(app.getPath('userData'), 'articles'),
  providers: () => join(app.getPath('userData'), 'providers.json'),
  bilibili: () => join(app.getPath('userData'), 'bilibili.json'),
  bilibiliAnalysis: () => join(app.getPath('userData'), 'bilibili-analysis.json'),
  // Locally retained video cards (soft-delete) and pinned videos.
  bilibiliArchive: () => join(app.getPath('userData'), 'bilibili-archive.json'),
  bilibiliPins: () => join(app.getPath('userData'), 'bilibili-pins.json'),
  // Locally-cached OpenRouter model catalog (public pricing/context data — plain
  // JSON, not a credential). Lets pricing auto-match offline and survive restart.
  openrouterCatalog: () => join(app.getPath('userData'), 'openrouter-catalog.json'),
  webSearch: () => join(app.getPath('userData'), 'web-search.json'),
  weather: () => join(app.getPath('userData'), 'weather.json'),
  // Persisted forecast cache so a window close/reopen (which destroys the
  // renderer's React Query cache) doesn't force a fresh HTTP fetch within the
  // disk TTL window. Separate file from weather.json (the config store).
  weatherCache: () => join(app.getPath('userData'), 'weather-forecast.json'),
  budgets: () => join(app.getPath('userData'), 'budgets.json'),
  gmail: () => join(app.getPath('userData'), 'gmail.json'),
  gmailDb: () => join(app.getPath('userData'), 'gmail.db'),
  calendar: () => join(app.getPath('userData'), 'calendar.json'),
  calendarDb: () => join(app.getPath('userData'), 'calendar.db'),
  workbench: () => join(app.getPath('userData'), 'workbench.json'),
  // Quick panel hotkey config (plaintext JSON, user-editable via Settings).
  quickPanel: () => join(app.getPath('userData'), 'quick-panel.json'),
} as const

/**
 * The path config Main hands to the service child process as env vars. Each
 * entry binds a SWARM_SERVICE_* name to its `paths` getter, so the service's
 * on-disk locations have a single source of truth here — adding a new store is
 * one line in this table, not a second hand-maintained list in index.ts that
 * can silently drift (the article store was lost exactly that way: SWARM_SERVICE_ARTICLES_DIR
 * was added to the service but never injected here, so it fell back to tmpdir()).
 */
export const servicePathEnv: ReadonlyArray<readonly [envName: string, getter: () => string]> = [
  ['SWARM_SERVICE_DB_PATH', paths.db],
  ['SWARM_SERVICE_MEMORY_PATH', paths.memory],
  ['SWARM_SERVICE_SKILLS_PATH', paths.skills],
  ['SWARM_SERVICE_AGENTS_PATH', paths.agents],
  ['SWARM_SERVICE_EXPORTS_DIR', paths.exports],
  ['SWARM_SERVICE_ARTICLES_DIR', paths.articles],
  ['SWARM_SERVICE_HOOKS_PATH', paths.hooks],
] as const

/**
 * Materialize the hand-editable subdirs so ~/.swarm-agents is a discoverable
 * drop-in home from first launch — without it the dir is empty until the user
 * saves a skill/agent (builtins live in-memory and are never written to disk).
 */
export function ensureSwarmDirs(): void {
  mkdirSync(paths.skills(), { recursive: true })
  mkdirSync(paths.agents(), { recursive: true })
}
