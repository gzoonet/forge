import type {
  ProjectModel,
  Decision,
  Constraint,
  Exploration,
  Tension,
  CommitmentLevel,
  NodeId,
} from '@gzoo/forge-core'

export function getDecisionsByCommitment(model: ProjectModel, level: CommitmentLevel): Decision[] {
  return Array.from(model.decisions.values()).filter(d => d.commitment === level)
}

export function getActiveExplorations(model: ProjectModel): Exploration[] {
  return Array.from(model.explorations.values()).filter(e => e.status === 'active')
}

export function getUnresolvedTensions(model: ProjectModel): Tension[] {
  return Array.from(model.tensions.values()).filter(t => t.status === 'active')
}

export function getConstraintsByType(model: ProjectModel, type: Constraint['type']): Constraint[] {
  return Array.from(model.constraints.values()).filter(c => c.type === type)
}

export function getDependentsOf(model: ProjectModel, decisionId: NodeId): Decision[] {
  return Array.from(model.decisions.values()).filter(d => d.dependsOn.includes(decisionId))
}

export function getDecisionsByCategory(model: ProjectModel, category: Decision['category']): Decision[] {
  return Array.from(model.decisions.values()).filter(d => d.category === category)
}
