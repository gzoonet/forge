import {
  createId,
  type NodeId,
  type ExecutionAction,
  type ProjectModel,
} from '@gzoo/forge-core'
import { ProjectModelStore } from '@gzoo/forge-store'
import type { ExecutionHook, ProposedAction, ActionResult } from './types'

export class ExecutionEngine {
  private hooks = new Map<string, ExecutionHook>()
  private actions = new Map<NodeId, ExecutionAction>()

  constructor(
    private store: ProjectModelStore,
    private projectId: NodeId
  ) {}

  registerHook(hook: ExecutionHook): void {
    this.hooks.set(hook.service, hook)
  }

  getRegisteredHooks(): string[] {
    return Array.from(this.hooks.keys())
  }

  // ── Propose Actions ──────────────────────────────────────────────────────

  async proposeActions(model: ProjectModel): Promise<ProposedAction[]> {
    const proposals: ProposedAction[] = []

    for (const [, hook] of this.hooks) {
      if (!hook.isConfigured()) continue

      try {
        const hookProposals = await hook.propose(model)
        proposals.push(...hookProposals)
      } catch (err) {
        console.warn(`[forge-execute] Hook ${hook.service} proposal failed:`, (err as Error).message)
      }
    }

    return proposals
  }

  // ── Create Action from Proposal ──────────────────────────────────────────

  createAction(proposal: ProposedAction): ExecutionAction {
    const action: ExecutionAction = {
      id: createId('decision'), // Reuse prefix system — could add 'action' prefix
      description: proposal.description,
      service: proposal.service,
      actionType: proposal.actionType,
      parameters: proposal.parameters,
      status: 'pending',
      sourceDecisionId: proposal.sourceDecisionId,
      sourceArtifactId: proposal.sourceArtifactId,
      sourceArtifactSectionId: proposal.sourceArtifactSectionId,
      requiresApproval: proposal.requiresApproval ?? true,
      isReversible: proposal.isReversible ?? false,
    }

    this.actions.set(action.id, action)
    return action
  }

  // ── Approve and Execute ──────────────────────────────────────────────────

  async approveAction(actionId: NodeId, sessionId: string): Promise<ExecutionAction> {
    const action = this.actions.get(actionId)
    if (!action) throw new Error(`Action not found: ${actionId}`)
    if (action.status !== 'pending') throw new Error(`Action ${actionId} is ${action.status}, not pending`)

    action.status = 'approved'
    action.approvedAt = new Date()
    action.approvedBy = sessionId

    return action
  }

  async executeAction(actionId: NodeId): Promise<ActionResult> {
    const action = this.actions.get(actionId)
    if (!action) throw new Error(`Action not found: ${actionId}`)
    if (action.requiresApproval && action.status !== 'approved') {
      throw new Error(`Action ${actionId} requires approval before execution`)
    }

    const hook = this.hooks.get(action.service)
    if (!hook) throw new Error(`No hook registered for service: ${action.service}`)

    action.status = 'executing'

    try {
      const result = await hook.execute(action)
      action.status = 'completed'
      action.result = result.data
      action.completedAt = new Date()
      return result
    } catch (err) {
      action.status = 'failed'
      action.error = (err as Error).message
      return {
        success: false,
        error: (err as Error).message,
      }
    }
  }

  // ── Approve + Execute in one step ────────────────────────────────────────

  async approveAndExecute(actionId: NodeId, sessionId: string): Promise<ActionResult> {
    await this.approveAction(actionId, sessionId)
    return this.executeAction(actionId)
  }

  // ── Query ────────────────────────────────────────────────────────────────

  getAction(actionId: NodeId): ExecutionAction | undefined {
    return this.actions.get(actionId)
  }

  getPendingActions(): ExecutionAction[] {
    return Array.from(this.actions.values()).filter(a => a.status === 'pending')
  }

  getCompletedActions(): ExecutionAction[] {
    return Array.from(this.actions.values()).filter(a => a.status === 'completed')
  }

  getFailedActions(): ExecutionAction[] {
    return Array.from(this.actions.values()).filter(a => a.status === 'failed')
  }

  getAllActions(): ExecutionAction[] {
    return Array.from(this.actions.values())
  }
}
