import type { ProjectModel, SessionBrief } from '@gzoo/forge-core'

/**
 * Serialize a ProjectModel to a plain JSON-safe object.
 * Converts all Maps to plain objects.
 */
export function serializeModel(model: ProjectModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    workspaceId: model.workspaceId,
    version: model.version,
    intent: {
      primaryGoal: model.intent.primaryGoal ?? null,
      scope: model.intent.scope,
      qualityBar: model.intent.qualityBar ?? null,
      successMetrics: model.intent.successMetrics ?? [],
      antiGoals: model.intent.antiGoals ?? [],
    },
    decisions: mapToArray(model.decisions),
    constraints: mapToArray(model.constraints),
    rejections: mapToArray(model.rejections),
    explorations: mapToArray(model.explorations),
    tensions: mapToArray(model.tensions),
    artifacts: Array.from(model.artifacts.values()).map(art => ({
      ...art,
      sections: mapToArray(art.sections),
    })),
    sessionIds: model.sessionIds,
  }
}

/**
 * Serialize active tensions from a model for the forge://tensions resource.
 */
export function serializeTensions(model: ProjectModel): Record<string, unknown>[] {
  return Array.from(model.tensions.values())
    .filter(t => t.status === 'active' || t.status === 'acknowledged')
    .map(t => ({
      id: t.id,
      description: t.description,
      severity: t.severity,
      status: t.status,
      nodeAId: t.nodeAId,
      nodeBId: t.nodeBId,
      nodeAType: t.nodeAType,
      nodeBType: t.nodeBType,
      nodeAStatement: findStatement(model, t.nodeAId),
      nodeBStatement: findStatement(model, t.nodeBId),
    }))
}

/**
 * Render a SessionBrief as readable markdown for Claude Code's context.
 */
export function formatBriefAsMarkdown(brief: SessionBrief): string {
  const lines: string[] = []

  lines.push(`# Project: ${brief.projectName}`)
  lines.push('')

  // Goal
  lines.push(`## Goal`)
  lines.push(brief.primaryGoal)
  lines.push('')

  // Locked decisions
  if (brief.lockedDecisions.length > 0) {
    lines.push(`## Locked Decisions`)
    for (const d of brief.lockedDecisions) {
      lines.push(`- **${d.statement}** [${d.category}]`)
    }
    lines.push('')
  }

  // Decided
  if (brief.decidedDecisions.length > 0) {
    lines.push(`## Decided`)
    for (const d of brief.decidedDecisions) {
      lines.push(`- ${d.statement} [${d.category}]`)
    }
    lines.push('')
  }

  // Pending explorations
  if (brief.pendingDecisions.length > 0) {
    lines.push(`## Pending Explorations`)
    for (const p of brief.pendingDecisions) {
      lines.push(`- ${p.topic}`)
      for (const q of p.openQuestions) {
        lines.push(`  - ${q}`)
      }
    }
    lines.push('')
  }

  // Active tensions
  if (brief.unresolvedTensions.length > 0) {
    lines.push(`## Active Tensions`)
    for (const t of brief.unresolvedTensions) {
      lines.push(`- [${t.severity}] ${t.description}`)
    }
    lines.push('')
  }

  // Artifacts in progress
  if (brief.artifactsInProgress.length > 0) {
    lines.push(`## Artifacts In Progress`)
    for (const a of brief.artifactsInProgress) {
      lines.push(`- [${a.status}] ${a.name} (${a.sectionsCommitted}/${a.sectionsInProgress + a.sectionsCommitted} sections)`)
    }
    lines.push('')
  }

  // Changes since last session
  if (brief.changesSinceLastSession.length > 0) {
    lines.push(`## Changes Since Last Session`)
    for (const c of brief.changesSinceLastSession) {
      lines.push(`- ${c}`)
    }
    lines.push('')
  }

  // Constraints from model (brief doesn't include these directly, but we add them in the resource)
  lines.push(`## Session`)
  lines.push(`- Previous outcome: ${brief.lastSessionOutcome}`)
  lines.push(`- Generated: ${brief.generatedAt.toISOString()}`)

  return lines.join('\n')
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapToArray<V>(map: Map<string, V>): V[] {
  return Array.from(map.values())
}

function findStatement(model: ProjectModel, nodeId: string): string | null {
  const decision = model.decisions.get(nodeId)
  if (decision) return decision.statement
  const constraint = model.constraints.get(nodeId)
  if (constraint) return constraint.statement
  const exploration = model.explorations.get(nodeId)
  if (exploration) return exploration.topic
  return null
}
