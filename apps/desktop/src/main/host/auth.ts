import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_CONFIG = 'ws-host.json'
// Loopback-only port for the agent-runtime WS host. Default 47777 so clients
// can discover it alongside the token in userData/ws-host.json. The
// SWARM_WS_HOST_PORT env var overrides it (used by e2e to avoid clashing with
// the user's running app on 47777); production leaves it unset.
const DEFAULT_PORT = 47777

function resolvePort(): number {
  const raw = process.env.SWARM_WS_HOST_PORT
  if (!raw) return DEFAULT_PORT
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export type HostConfig = { port: number; token: string }

export function loadOrCreateHostConfig(userDataDir: string): HostConfig {
  const file = join(userDataDir, HOST_CONFIG)
  if (existsSync(file)) {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as HostConfig
    if (typeof cfg.port === 'number' && typeof cfg.token === 'string') return cfg
  }
  const cfg: HostConfig = { port: resolvePort(), token: generateToken() }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}
