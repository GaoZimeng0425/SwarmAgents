import { createFileRoute } from '@tanstack/react-router'

import { TrendingView } from '@/components/views/trending-view'

export const Route = createFileRoute('/trending')({ component: TrendingView })
