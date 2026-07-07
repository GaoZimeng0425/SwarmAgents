import { createFileRoute } from '@tanstack/react-router'

import { ArticleView } from '@/components/views/article-view'

export const Route = createFileRoute('/articles')({ component: ArticleView })
