import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '@/lib/api'

export type TeamOption = { id: string; label: string }

/** Team-selector options: the company (CEO) default plus one entry per team head. */
export function useTeamOptions(): TeamOption[] {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const heads = (data ?? []).filter((a) => a.teamRole === 'head').map((a) => ({ id: a.id, label: a.name }))
  return [{ id: 'ceo', label: '公司 (CEO)' }, ...heads]
}
