import { createFileRoute } from '@tanstack/react-router'

import { McpServersView } from '@/components/views/mcp-servers-view'

export const Route = createFileRoute('/mcp')({ component: McpServersView })
