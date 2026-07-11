import { createFileRoute } from '@tanstack/react-router'

import { GlassDemoView } from '@/components/views/glass-demo-view'

export const Route = createFileRoute('/glass')({ component: GlassDemoView })
