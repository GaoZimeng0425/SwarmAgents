import { createFileRoute } from '@tanstack/react-router'

import { BilibiliView } from '@/components/views/bilibili-view'

export const Route = createFileRoute('/bilibili')({ component: BilibiliView })
