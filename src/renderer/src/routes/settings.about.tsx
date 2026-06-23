import { createFileRoute } from '@tanstack/react-router'

import { AboutView } from '@/components/views/about-view'

export const Route = createFileRoute('/settings/about')({ component: AboutView })
