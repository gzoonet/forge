import type { NodeId, ExecutionAction, ProjectModel } from '@gzoo/forge-core'

export type ProposedAction = {
  description: string
  service: string
  actionType: string
  parameters: Record<string, unknown>
  sourceDecisionId?: NodeId
  sourceArtifactId?: NodeId
  sourceArtifactSectionId?: NodeId
  requiresApproval?: boolean
  isReversible?: boolean
  reason: string // Why this action is being proposed
}

export type ActionResult = {
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

export interface ExecutionHook {
  service: string
  description: string

  /** Check if this hook is properly configured (e.g., API keys present) */
  isConfigured(): boolean

  /** Propose actions based on the current model state */
  propose(model: ProjectModel): Promise<ProposedAction[]>

  /** Execute a specific action */
  execute(action: ExecutionAction): Promise<ActionResult>

  /** Rollback a completed action (if reversible) */
  rollback?(action: ExecutionAction): Promise<ActionResult>
}

export type GitHubConfig = {
  token: string
  owner: string
  defaultVisibility?: 'public' | 'private'
}
