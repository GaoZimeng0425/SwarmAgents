import { createFileRoute } from '@tanstack/react-router'

import { GeneralView } from '@/components/views/general-view'

export const Route = createFileRoute('/settings/')({ component: GeneralView })
