import { createFileRoute } from '@tanstack/react-router'

import { ProvidersView } from '@/components/views/providers-view'

export const Route = createFileRoute('/settings/providers')({ component: ProvidersView })
