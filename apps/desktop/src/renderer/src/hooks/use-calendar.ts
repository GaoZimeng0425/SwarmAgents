import type { CalendarEvent, CalendarLocalInput } from '@swarm/protocol'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export const CALENDAR_RANGE_KEY = (fromMs: number, toMs: number): unknown[] => ['calendar', 'range', fromMs, toMs]

// Invalidate every 'calendar' query (status + any range). Used after local
// CRUD and on calendar:stateChanged pushes from main.
function invalidateCalendar(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['calendar'] })
}

export function useCalendarEvents(from: Date, to: Date) {
  return useQuery<CalendarEvent[]>({
    queryKey: CALENDAR_RANGE_KEY(from.getTime(), to.getTime()),
    queryFn: () => window.swarm.calendar.listInRange(from.getTime(), to.getTime()),
  })
}

export function useCreateLocalEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CalendarLocalInput) => window.swarm.calendar.createLocal(input),
    onSuccess: () => invalidateCalendar(qc),
  })
}

export function useDeleteLocalEvent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.swarm.calendar.deleteLocal(id),
    onSuccess: () => invalidateCalendar(qc),
  })
}
