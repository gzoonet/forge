import {
  createId,
  createProvenance,
  type NodeId,
  type ProjectModel,
  type Decision,
  type Constraint,
  type Exploration,
  type Tension,
  type ConstraintPropagation,
  type ConstraintScore,
  type ConstraintConflict,
  type ClosedOption,
  type Escalation,
  type Provenance,
} from '@gzoo/forge-core'
import { ProjectModelStore } from '@gzoo/forge-store'
import type { LLMClient } from './llm-client'
import { CONSTRAINT_PROPAGATION_SYSTEM_PROMPT } from './prompts/propagation'
import { CONSTRAINT_CONFLICT_SYSTEM_PROMPT } from './prompts/conflict'

// ── Constraint Scoring ───────────────────────────────────────────────────────

const WEIGHTS = {
  recency: 0.25,
  frequency: 0.35,
  consistency: 0.25,
  stakes: 0.15,
}

export function computeConstraintScore(
  constraint: Constraint,
  model: ProjectModel,
  currentTurnIndex: number,
  totalTurns: number
): ConstraintScore {
  // Recency: how recently was this constraint evidenced?
  const originTurn = constraint.originStatementTurn ?? constraint.provenance.turnIndex
  const recency = totalTurns > 0
    ? Math.round((originTurn / totalTurns) * 100)
    : 50

  // Frequency: how many times has this appeared?
  // For revealed constraints, count evidence instances
  // For stated constraints, count = 1 unless reinforced
  const frequency = constraint.isRevealed
    ? Math.min(100, (constraint.revealedEvidence?.length ?? 1) * 25)
    : 15

  // Consistency: has it been contradicted?
  // Check if any decisions or other constraints conflict with this one
  let contradictions = 0
  for (const [, dec] of model.decisions) {
    if (isContradictory(constraint.statement, dec.statement)) {
      contradictions++
    }
  }
  const consistency = contradictions === 0 ? 80 : Math.max(10, 80 - contradictions * 20)

  // Stakes: how many downstream decisions does this affect?
  const propagationCount = constraint.propagatesTo.length
  const decisionCount = model.decisions.size
  const stakes = decisionCount > 0
    ? Math.min(100, Math.round((propagationCount / Math.max(decisionCount, 1)) * 100) + 30)
    : 50

  const total = Math.round(
    recency * WEIGHTS.recency +
    frequency * WEIGHTS.frequency +
    consistency * WEIGHTS.consistency +
    stakes * WEIGHTS.stakes
  )

  return { total, recency, frequency, consistency, stakes }
}

function isContradictory(a: string, b: string): boolean {
  // Simple heuristic — check for negation patterns
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  const negations = ['not', 'no ', 'never', 'avoid', 'without', 'instead of']
  for (const neg of negations) {
    if (aLower.includes(neg) && !bLower.includes(neg)) {
      // Check if they share significant keywords
      const aWords = aLower.split(/\s+/).filter(w => w.length > 4)
      const bWords = bLower.split(/\s+/).filter(w => w.length > 4)
      const overlap = aWords.filter(w => bWords.includes(w))
      if (overlap.length > 0) return true
    }
  }
  return false
}

// ── Constraint Conflict Detection ────────────────────────────────────────────

export async function detectConstraintConflicts(
  model: ProjectModel,
  currentTurnIndex: number,
  totalTurns: number,
  llmClient?: LLMClient
): Promise<ConstraintConflict[]> {
  const statedConstraints = Array.from(model.constraints.values()).filter(c => !c.isRevealed)
  const revealedConstraints = Array.from(model.constraints.values()).filter(c => c.isRevealed)
  const conflicts: ConstraintConflict[] = []

  for (const stated of statedConstraints) {
    for (const revealed of revealedConstraints) {
      if (stated.conflictId || revealed.conflictId) continue

      // Fast pre-filter: skip pairs that obviously don't interact
      if (!constraintsMayConflict(stated, revealed)) continue

      // LLM-assisted semantic check: confirm the conflict is real
      if (llmClient) {
        const isReal = await checkConstraintConflictLLM(stated, revealed, llmClient)
        if (!isReal) continue
      }

      const statedScore = computeConstraintScore(stated, model, currentTurnIndex, totalTurns)
      const revealedScore = computeConstraintScore(revealed, model, currentTurnIndex, totalTurns)
      const delta = Math.abs(statedScore.total - revealedScore.total)

      const winner: 'stated' | 'revealed' | 'unresolved' =
        delta < 15 ? 'unresolved' :
        statedScore.total > revealedScore.total ? 'stated' : 'revealed'

      conflicts.push({
        id: createId('tension'),
        statedConstraintId: stated.id,
        revealedConstraintId: revealed.id,
        statedScore,
        revealedScore,
        winner,
        surfacedAt: new Date(),
      })
    }
  }

  return conflicts
}

function constraintsMayConflict(a: Constraint, b: Constraint): boolean {
  // Same type of constraint with different orientations suggests conflict
  if (a.type === b.type) return true
  // Check for keyword overlap that might indicate the same topic
  const aWords = a.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
  const bWords = b.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
  const overlap = aWords.filter(w => bWords.includes(w))
  return overlap.length >= 2
}

// ── LLM-Assisted Conflict Verification ──────────────────────────────────────

export async function checkConstraintConflictLLM(
  a: Constraint,
  b: Constraint,
  llmClient: LLMClient
): Promise<boolean> {
  const prompt = `Constraint A: "${a.statement}" [${a.type}, ${a.hardness}]\nConstraint B: "${b.statement}" [${b.type}, ${b.hardness}]\n\nDo these two constraints conflict?`

  try {
    const response = await llmClient.complete({
      system: CONSTRAINT_CONFLICT_SYSTEM_PROMPT,
      prompt,
      model: 'haiku',
      maxTokens: 300,
    })

    const cleaned = response.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return parsed.isConflicting === true
  } catch {
    // On LLM failure, fall back to heuristic (assume conflict if pre-filter passed)
    console.warn('[forge-extract] Constraint conflict LLM check failed, falling back to heuristic')
    return true
  }
}

// ── Constraint Propagation (LLM-assisted) ────────────────────────────────────

export type PropagationResult = {
  tensions: Array<{
    description: string
    affectedNodeId: NodeId
    affectedNodeType: 'decision' | 'exploration' | 'constraint'
    severity: 'informational' | 'significant' | 'blocking'
    impact: string
  }>
  closedOptions: ClosedOption[]
  shouldEscalate: boolean
  escalationReason?: string
}

export async function checkPropagation(
  newDecision: Decision,
  model: ProjectModel,
  llmClient: LLMClient
): Promise<PropagationResult> {
  // Skip propagation for low-stakes decisions
  if (isLowStakes(newDecision)) {
    return { tensions: [], closedOptions: [], shouldEscalate: false }
  }

  // Build context for LLM analysis
  const prompt = buildPropagationPrompt(newDecision, model)

  try {
    const response = await llmClient.complete({
      system: CONSTRAINT_PROPAGATION_SYSTEM_PROMPT,
      prompt,
      model: 'sonnet',
      maxTokens: 2000,
    })

    return parsePropagationResponse(response.text, model)
  } catch (err) {
    console.warn('[forge-extract] Constraint propagation check failed:', (err as Error).message)
    return { tensions: [], closedOptions: [], shouldEscalate: false }
  }
}

function isLowStakes(decision: Decision): boolean {
  // Brand decisions with low certainty are typically low-stakes
  if (decision.category === 'brand' && decision.certainty === 'assumed') return true
  // Decisions without rationale and no alternatives are likely trivial
  if (!decision.rationale && decision.alternatives.length === 0 &&
      decision.category === 'brand') return true
  return false
}

function buildPropagationPrompt(decision: Decision, model: ProjectModel): string {
  const parts: string[] = []

  parts.push(`## New Decision`)
  parts.push(`Statement: ${decision.statement}`)
  parts.push(`Category: ${decision.category}`)
  parts.push(`Commitment: ${decision.commitment}`)
  if (decision.rationale) parts.push(`Rationale: ${decision.rationale}`)

  // Existing decisions
  const existingDecisions = Array.from(model.decisions.values())
    .filter(d => d.id !== decision.id)
  if (existingDecisions.length > 0) {
    parts.push('\n## Existing Decisions')
    for (const d of existingDecisions) {
      parts.push(`- [${d.commitment}|${d.category}] ${d.statement} (ID: ${d.id})`)
    }
  }

  // Existing constraints
  const constraints = Array.from(model.constraints.values())
  if (constraints.length > 0) {
    parts.push('\n## Existing Constraints')
    for (const c of constraints) {
      parts.push(`- [${c.hardness}|${c.type}] ${c.statement} (ID: ${c.id})`)
    }
  }

  // Active explorations
  const explorations = Array.from(model.explorations.values())
    .filter(e => e.status === 'active')
  if (explorations.length > 0) {
    parts.push('\n## Active Explorations')
    for (const e of explorations) {
      parts.push(`- ${e.topic}: ${e.direction} (ID: ${e.id})`)
    }
  }

  // Intent
  if (model.intent.primaryGoal) {
    parts.push(`\n## Project Goal`)
    parts.push(model.intent.primaryGoal.statement)
  }

  return parts.join('\n')
}

function parsePropagationResponse(text: string, model: ProjectModel): PropagationResult {
  // Strip markdown fences
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    const tensions: PropagationResult['tensions'] = []
    const closedOptions: ClosedOption[] = []

    if (Array.isArray(parsed.tensions)) {
      for (const t of parsed.tensions) {
        // Validate the affected node exists
        const nodeId = t.affectedNodeId as string
        const nodeExists =
          model.decisions.has(nodeId) ||
          model.constraints.has(nodeId) ||
          model.explorations.has(nodeId)

        if (nodeExists && t.description && t.severity) {
          tensions.push({
            description: t.description,
            affectedNodeId: nodeId,
            affectedNodeType: t.affectedNodeType ?? 'decision',
            severity: t.severity,
            impact: t.impact ?? t.description,
          })
        }
      }
    }

    if (Array.isArray(parsed.closedOptions)) {
      for (const co of parsed.closedOptions) {
        if (co.description) {
          closedOptions.push({
            description: co.description,
            reversalCost: co.reversalCost ?? 'medium',
            affectedDecisionIds: Array.isArray(co.affectedDecisionIds) ? co.affectedDecisionIds : [],
            detectedAt: new Date(),
          })
        }
      }
    }

    const shouldEscalate = parsed.shouldEscalate === true ||
      tensions.some(t => t.severity === 'significant' || t.severity === 'blocking')

    return {
      tensions,
      closedOptions,
      shouldEscalate,
      escalationReason: parsed.escalationReason,
    }
  } catch {
    return { tensions: [], closedOptions: [], shouldEscalate: false }
  }
}

// ── Apply Propagation Results ────────────────────────────────────────────────

export function applyPropagationResults(
  result: PropagationResult,
  decision: Decision,
  model: ProjectModel,
  store: ProjectModelStore,
  provenance: Provenance,
  context: { projectId: NodeId; sessionId: string; turnIndex: number }
): { tensionIds: NodeId[]; escalation?: Escalation } {
  const tensionIds: NodeId[] = []

  // Create tension nodes
  for (const t of result.tensions) {
    const tensionId = createId('tension')
    const tension: Tension = {
      id: tensionId,
      description: t.description,
      nodeAId: decision.id,
      nodeBId: t.affectedNodeId,
      nodeAType: 'decision',
      nodeBType: t.affectedNodeType as any,
      severity: t.severity,
      detectedAt: new Date(),
      provenance,
      status: 'active',
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'tension', node: tension, provenance },
      context
    )
    tensionIds.push(tensionId)
  }

  // Update the decision's closedOptions
  if (result.closedOptions.length > 0) {
    decision.closedOptions.push(...result.closedOptions)
  }

  // Build escalation if needed
  let escalation: Escalation | undefined
  if (result.shouldEscalate && result.tensions.length > 0) {
    escalation = {
      id: createId('tension'),
      triggeredAt: new Date(),
      turnIndex: context.turnIndex,
      reason: result.escalationReason ?? 'Decision creates material constraint conflicts',
      constraintPropagations: result.tensions.map(t => ({
        affectedNodeId: t.affectedNodeId,
        affectedNodeType: t.affectedNodeType as any,
        impact: t.impact,
        severity: t.severity === 'significant' ? 'limiting' as const : t.severity,
      })),
      affectedNodeIds: result.tensions.map(t => t.affectedNodeId),
      wasAcknowledged: false,
    }
  }

  return { tensionIds, escalation }
}
