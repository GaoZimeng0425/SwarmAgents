import type { PermissionDecision, SubmitGoalResult, UIEvent } from '@shared/types/ui'

export const swarmApi = {
  submitGoal: (goal: string): Promise<SubmitGoalResult> => window.swarm.submitGoal(goal),
  cancelTask: (taskId: string): Promise<void> => window.swarm.cancelTask(taskId),
  decidePermission: (
    actionId: string,
    decision: PermissionDecision,
  ): Promise<void> => window.swarm.decidePermission(actionId, decision),
  subscribeEvents: (cb: (e: UIEvent) => void): (() => void) =>
    window.swarm.subscribeEvents(cb),
}
