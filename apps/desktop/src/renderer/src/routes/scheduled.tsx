import { createFileRoute } from '@tanstack/react-router'

import { ScheduledCalendarView } from '@/components/views/scheduled-calendar-view'

export const Route = createFileRoute('/scheduled')({ component: ScheduledCalendarView })
