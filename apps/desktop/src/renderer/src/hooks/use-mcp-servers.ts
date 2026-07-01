import { useEffect, useMemo, useState } from 'react'
import type { McpServerConfig, McpServerStatus } from '@swarm/protocol'

/** Live MCP config + connection status from main/service. */
export function useMcpServers(): {
  servers: McpServerConfig[]
  statusById: Map<string, McpServerStatus>
} {
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])

  useEffect(() => {
    void window.swarm.mcp.list().then(setServers)
    void window.swarm.mcp.getStatus().then(setStatuses)
    const offConfig = window.swarm.mcp.onConfigChanged(setServers)
    const offStatus = window.swarm.mcp.onStatus(setStatuses)
    return () => {
      offConfig()
      offStatus()
    }
  }, [])

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  return { servers, statusById }
}
