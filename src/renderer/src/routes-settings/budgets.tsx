import { createFileRoute } from '@tanstack/react-router'

import { BudgetsView } from '@/components/views/budgets-view'

export const Route = createFileRoute('/budgets')({ component: BudgetsView })
