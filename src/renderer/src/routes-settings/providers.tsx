import { createFileRoute } from '@tanstack/react-router'

import { ProvidersView } from '@/components/views/providers-view'

export const Route = createFileRoute('/providers')({ component: ProvidersView })
