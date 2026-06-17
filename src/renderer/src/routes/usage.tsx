import { createFileRoute } from '@tanstack/react-router'

import { UsageView } from '@/components/views/usage-view'

export const Route = createFileRoute('/usage')({ component: UsageView })
