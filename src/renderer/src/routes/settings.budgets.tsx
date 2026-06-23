import { createFileRoute } from '@tanstack/react-router'

import { BudgetsView } from '@/components/views/budgets-view'

export const Route = createFileRoute('/settings/budgets')({ component: BudgetsView })
