import { createContext, type ReactNode, useContext, useRef, useState } from 'react'
import { createServiceClient, type ServiceClient } from '@swarm/protocol'

import type { ConnectionConfig } from '@/lib/parse-config'
import { createWsTransport } from '@/lib/transport-ws'

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

type ConnectionState = {
  status: ConnectionStatus
  config: ConnectionConfig | null
  client: ServiceClient | null
  error: string | null
  connect: (config: ConnectionConfig) => Promise<boolean>
  disconnect: () => void
  reconnect: () => Promise<boolean>
}

const ConnectionContext = createContext<ConnectionState | null>(null)

// Minimal event emitter for broadcasting RPC events to hook subscribers.
// Module-level singleton: the onEvent callback below forwards every event here,
// and the message-event-source adapter subscribes through `on('*')`.
export type EventHandler = (data: unknown) => void
export const eventEmitter = {
  handlers: new Map<string, Set<EventHandler>>(),
  on(event: string, fn: EventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
    }
  },
  emit(event: string, data: unknown): void {
    // Wildcard subscribers receive all events, wrapped with the event name.
    this.handlers.get('*')?.forEach((fn) => {
      fn({ event, data })
    })
    this.handlers.get(event)?.forEach((fn) => {
      fn(data)
    })
  },
}

export function ConnectionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [config, setConfig] = useState<ConnectionConfig | null>(null)
  const [client, setClient] = useState<ServiceClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keep the raw transport close fn so disconnect can tear it down. The
  // ServiceClient only detaches its own message listener, not the socket.
  const closeRef = useRef<(() => void) | null>(null)
  const clientRef = useRef<ServiceClient | null>(null)
  const configRef = useRef<ConnectionConfig | null>(null)

  const doConnect = async (cfg: ConnectionConfig): Promise<boolean> => {
    setStatus('connecting')
    setError(null)
    try {
      const { transport, ready, close } = createWsTransport(cfg, () => {
        // Socket closed unexpectedly — leave the connected state. configRef is
        // intentionally preserved so the user can reconnect from settings.
        clientRef.current = null
        closeRef.current = null
        setClient(null)
        setStatus('error')
        setError('连接已断开')
      })
      closeRef.current = close

      const sc = createServiceClient({
        transport,
        onEvent: (event, data) => {
          // Forward every RPC event to subscribers via the module emitter.
          eventEmitter.emit(event, data)
        },
      })
      await ready
      await sc.connect()

      clientRef.current = sc
      configRef.current = cfg
      setClient(sc)
      setConfig(cfg)
      setStatus('connected')
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStatus('error')
      closeRef.current = null
      clientRef.current = null
      return false
    }
  }

  const doDisconnect = (): void => {
    clientRef.current?.disconnect()
    closeRef.current?.()
    clientRef.current = null
    closeRef.current = null
    setClient(null)
    setStatus('idle')
  }

  const doReconnect = async (): Promise<boolean> => {
    const cfg = configRef.current
    if (!cfg) return false
    doDisconnect()
    return doConnect(cfg)
  }

  return (
    <ConnectionContext.Provider
      value={{
        status,
        config,
        client,
        error,
        connect: doConnect,
        disconnect: doDisconnect,
        reconnect: doReconnect,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}
