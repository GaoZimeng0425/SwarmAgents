import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_CONFIG = 'ws-host.json'
// Loopback-only port for the agent-runtime WS host. Fixed so clients can
// discover it alongside the token in userData/ws-host.json.
const DEFAULT_PORT = 47777

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
  const cfg: HostConfig = { port: DEFAULT_PORT, token: generateToken() }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}
