import type {
  ProjectModel,
  SessionBrief,
  BriefDecision,
  BriefExploration,
  BriefTension,
  BriefArtifact,
  NodeId,
} from '@gzoo/forge-core'
import type { ProjectModelStore } from '@gzoo/forge-store'
import { getDecisionsByCommitment, getActiveExplorations, getUnresolvedTensions } from '@gzoo/forge-store'

export function generateSessionBrief(
  model: ProjectModel,
  store: ProjectModelStore,
  sessionId: string,
  previousSessionId?: string
): SessionBrief {
  const locked = getDecisionsByCommitment(model, 'locked')
  const decided = getDecisionsByCommitment(model, 'decided')
  const leaning = getDecisionsByCommitment(model, 'leaning')
  const activeExplorations = getActiveExplorations(model)
  const tensions = getUnresolvedTensions(model)

  const toBriefDecision = (d: { statement: string; commitment: any; category: any }): BriefDecision => ({
    statement: d.statement,
    commitment: d.commitment,
    category: d.category,
  })

  const toBriefExploration = (e: { topic: string; openQuestions: string[] }): BriefExploration => ({
    topic: e.topic,
    openQuestions: e.openQuestions,
  })

  const toBriefTension = (t: { description: string; severity: any }): BriefTension => ({
    description: t.description,
    severity: t.severity,
  })

  // Pending = active explorations + leaning decisions (things not yet committed)
  const pendingDecisions: BriefExploration[] = [
    ...activeExplorations.map(toBriefExploration),
    ...leaning.map(d => ({ topic: d.statement, openQuestions: [] as string[] })),
  ]

  // Artifacts
  const artifactsInProgress: BriefArtifact[] = []
  const recentlyCommitted: BriefArtifact[] = []
  for (const [, art] of model.artifacts) {
    const brief: BriefArtifact = {
      name: art.name,
      type: art.type,
      status: art.status,
      sectionsInProgress: Array.from(art.sections.values()).filter(s => s.status === 'draft').length,
      sectionsCommitted: Array.from(art.sections.values()).filter(s => s.status === 'committed').length,
    }
    if (art.status === 'committed') {
      recentlyCommitted.push(brief)
    } else {
      artifactsInProgress.push(brief)
    }
  }

  // Changes since last session
  let changesSinceLastSession: string[] = []
  if (previousSessionId) {
    const changes = store.getChangesSinceSession(model.id, previousSessionId)
    changesSinceLastSession = changes.map(c => {
      switch (c.changeType) {
        case 'created': return `New ${c.nodeType}: ${typeof c.newValue === 'object' && c.newValue && 'statement' in c.newValue ? (c.newValue as any).statement : c.nodeId}`
        case 'updated': return `Updated ${c.nodeType}: ${c.nodeId}`
        case 'promoted': return `Promoted ${c.nodeType}: ${c.previousValue} → ${c.newValue}`
        default: return `${c.changeType} ${c.nodeType}`
      }
    })
  }

  return {
    generatedAt: new Date(),
    projectName: model.name,
    primaryGoal: model.intent.primaryGoal?.statement ?? 'Not yet defined',
    lockedDecisions: locked.map(toBriefDecision),
    decidedDecisions: decided.map(toBriefDecision),
    pendingDecisions,
    unresolvedTensions: tensions.map(toBriefTension),
    changesSinceLastSession,
    lastSessionGoal: model.intent.primaryGoal?.statement ?? '',
    lastSessionOutcome: decided.length > 0
      ? `${decided.length} decided, ${locked.length} locked`
      : 'No committed decisions yet',
    artifactsInProgress,
    recentlyCommitted,
  }
}
