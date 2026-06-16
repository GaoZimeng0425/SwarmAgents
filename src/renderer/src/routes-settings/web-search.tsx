import { createFileRoute } from '@tanstack/react-router'

import { WebSearchView } from '@/components/views/web-search-view'

export const Route = createFileRoute('/web-search')({ component: WebSearchView })
