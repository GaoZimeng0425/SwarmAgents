import { createFileRoute } from '@tanstack/react-router'

import { FormationsView } from '@/components/views/formations-view'
export const Route = createFileRoute('/formations')({ component: FormationsView })
