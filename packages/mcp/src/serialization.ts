import type { ProjectModel, SessionBrief, ExtractionResult } from '@gzoo/forge-core'
import type { StoredEvent, StoredTurn } from '@gzoo/forge-store'

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

/**
 * Format a turn diff as markdown showing what changed.
 */
export function formatDiffAsMarkdown(
  turn: StoredTurn,
  events: StoredEvent[],
  model: ProjectModel
): string {
  const lines: string[] = []

  lines.push(`# Turn ${turn.turnIndex} Diff`)
  lines.push('')

  // Classification
  if (turn.classification && turn.classification.length > 0) {
    const primary = turn.classification[0]
    lines.push(`**Classification:** ${primary.type} (${primary.confidence} confidence)`)
    if (turn.classification.length > 1) {
      const others = turn.classification.slice(1).map(c => c.type).join(', ')
      lines.push(`**Also:** ${others}`)
    }
    lines.push('')
  }

  // What the user said
  lines.push(`## Input`)
  lines.push(`> ${turn.text}`)
  lines.push('')

  // Filter to meaningful events (skip session lifecycle)
  const meaningful = events.filter(e =>
    e.type !== 'SESSION_STARTED' && e.type !== 'SESSION_ENDED'
  )

  if (meaningful.length === 0) {
    lines.push('*No model changes this turn.*')
    return lines.join('\n')
  }

  // Group by type
  lines.push(`## Changes (${meaningful.length})`)
  lines.push('')

  for (const event of meaningful) {
    switch (event.type) {
      case 'NODE_CREATED': {
        const nodeType = event.nodeType
        const node = event.node as Record<string, unknown>
        const label = (node.statement as string) || (node.topic as string) || (node.name as string) || String(node.id)
        lines.push(`- **+** [${nodeType}] ${label}`)
        if (node.commitment) lines.push(`  - Commitment: ${node.commitment}`)
        if (node.category) lines.push(`  - Category: ${node.category}`)
        if (node.rationale) lines.push(`  - Rationale: ${node.rationale}`)
        break
      }
      case 'NODE_UPDATED': {
        const stmt = findStatement(model, event.nodeId) || event.nodeId
        const fields = Object.keys(event.changes).join(', ')
        lines.push(`- **~** [${event.nodeType}] ${stmt}`)
        lines.push(`  - Changed: ${fields}`)
        break
      }
      case 'NODE_PROMOTED': {
        const stmt = findStatement(model, event.nodeId) || event.nodeId
        const auto = event.wasAutomatic ? ' (auto)' : ''
        lines.push(`- **^** ${stmt}: ${event.from} → ${event.to}${auto}`)
        break
      }
      case 'NODE_REJECTED': {
        lines.push(`- **x** [${event.nodeType}] ${event.nodeId}: ${event.reason}`)
        break
      }
      case 'INTENT_UPDATED': {
        lines.push(`- **~** [intent.${event.field}] updated`)
        break
      }
      case 'TENSION_DETECTED': {
        const t = event.tension
        lines.push(`- **!** Tension: ${t.description} [${t.severity}]`)
        break
      }
      case 'TENSION_RESOLVED': {
        lines.push(`- **✓** Tension resolved: ${event.resolution}`)
        break
      }
      case 'ESCALATION_TRIGGERED': {
        lines.push(`- **⚠** Escalation: ${event.escalation.reason}`)
        break
      }
      case 'CORRECTION_APPLIED': {
        const stmt = findStatement(model, event.targetNodeId) || event.targetNodeId
        lines.push(`- **↺** Correction to: ${stmt}`)
        break
      }
    }
  }

  // Extraction metadata
  const result = turn.extractionResult
  if (result) {
    const extras: string[] = []
    if (result.constraintChecksTriggered) extras.push('constraint propagation ran')
    if (result.conflictChecksTriggered) extras.push('conflict detection ran')
    if (result.escalationRequired) extras.push(`escalation: ${result.escalationReason}`)
    if (result.memoryMatches && result.memoryMatches.length > 0) {
      extras.push(`${result.memoryMatches.length} memory match${result.memoryMatches.length > 1 ? 'es' : ''}`)
    }
    if (result.cortexMatches && result.cortexMatches.length > 0) {
      extras.push(`${result.cortexMatches.length} Cortex match${result.cortexMatches.length > 1 ? 'es' : ''}`)
    }

    if (extras.length > 0) {
      lines.push('')
      lines.push(`## Pipeline`)
      for (const e of extras) {
        lines.push(`- ${e}`)
      }
    }
  }

  return lines.join('\n')
}
