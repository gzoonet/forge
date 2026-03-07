import {
  createId,
  createProvenance,
  type NodeId,
  type TurnType,
  type ConversationalTurn,
  type ExtractionResult,
  type ModelUpdate,
  type PromotionCheck,
  type Decision,
  type Constraint,
  type Rejection,
  type Exploration,
  type CommitmentLevel,
  type Provenance,
} from '@gzoo/forge-core'
import { ProjectModelStore } from '@gzoo/forge-store'
import type { LLMClient } from './llm-client'
import { classify } from './classifier'
import { extract, isExtractable, type ExtractedNode } from './extractor'

export class ExtractionPipeline {
  constructor(
    private store: ProjectModelStore,
    private llmClient: LLMClient
  ) {}

  async processTurn(
    turn: ConversationalTurn,
    projectId: NodeId
  ): Promise<ExtractionResult> {
    const startTime = Date.now()

    // Store the raw turn
    this.store.appendTurn({
      sessionId: turn.sessionId,
      projectId,
      turnIndex: turn.turnIndex,
      speaker: turn.speaker,
      text: turn.text,
      timestamp: turn.timestamp,
    })

    // Stage 1: Classify
    const recentContext = await this.getRecentContext(turn.sessionId, turn.turnIndex)
    const classification = await classify(turn.text, recentContext, this.llmClient)

    // Collect all types from classification
    const allTypes: TurnType[] = [classification.primary, ...(classification.additional ?? [])]

    // Early exit for turns that don't produce model updates
    const noOpTypes: TurnType[] = ['question', 'meta']
    if (allTypes.every(t => noOpTypes.includes(t))) {
      return {
        turnRef: { sessionId: turn.sessionId, turnIndex: turn.turnIndex },
        classifications: [{ type: classification.primary, confidence: classification.confidence, additionalTypes: classification.additional }],
        modelUpdates: [],
        promotionChecks: [],
        constraintChecksTriggered: false,
        conflictChecksTriggered: false,
        escalationRequired: false,
      }
    }

    // Stage 2: Extract per classification type
    const modelUpdates: ModelUpdate[] = []
    const promotionChecks: PromotionCheck[] = []

    for (const turnType of allTypes) {
      if (!isExtractable(turnType)) continue

      const extracted = await extract(turnType, turn.text, recentContext, this.llmClient)
      if (!extracted) continue

      const provenance = createProvenance(
        turn.sessionId,
        turn.turnIndex,
        turn.text,
        classification.confidence
      )

      const update = this.writeToModel(extracted, projectId, provenance, turn.sessionId, turn.turnIndex)
      if (update) modelUpdates.push(update)

      // Check for promotion eligibility after write
      const promoCheck = this.checkPromotionEligibility(extracted, projectId, turn.sessionId, turn.turnIndex)
      if (promoCheck) promotionChecks.push(promoCheck)
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 500) {
      console.warn(`[forge-extract] Turn ${turn.turnIndex} took ${elapsed}ms (target: 500ms)`)
    }

    return {
      turnRef: { sessionId: turn.sessionId, turnIndex: turn.turnIndex },
      classifications: [{ type: classification.primary, confidence: classification.confidence, additionalTypes: classification.additional }],
      modelUpdates,
      promotionChecks,
      constraintChecksTriggered: modelUpdates.some(u =>
        u.targetLayer === 'constraints' || u.targetLayer === 'decisions'
      ),
      conflictChecksTriggered: false, // Phase 1: detect but not resolve
      escalationRequired: false,
    }
  }

  private async getRecentContext(sessionId: string, currentTurnIndex: number): Promise<string> {
    const turns = this.store.getSessionTurns(sessionId)
    return turns
      .filter(t => t.turnIndex < currentTurnIndex)
      .slice(-5)
      .map(t => `${t.speaker}: ${t.text}`)
      .join('\n')
  }

  private writeToModel(
    extracted: ExtractedNode,
    projectId: NodeId,
    provenance: Provenance,
    sessionId: string,
    turnIndex: number
  ): ModelUpdate | null {
    const context = { projectId, sessionId, turnIndex }

    switch (extracted.turnType) {
      case 'goal_statement': {
        const { data } = extracted
        this.store.appendEvent({
          type: 'INTENT_UPDATED',
          projectId,
          field: 'primaryGoal',
          value: {
            statement: data.statement,
            successCriteria: data.successCriteria,
            provenance,
            commitment: data.commitment,
          },
          provenance,
        }, context)

        return {
          operation: 'update',
          targetLayer: 'intent',
          nodeId: projectId,
          changes: { primaryGoal: data.statement },
        }
      }

      case 'decision': {
        const { data } = extracted
        const id = createId('decision')
        const decision: Decision = {
          id,
          category: data.category,
          statement: data.statement,
          rationale: data.rationale,
          alternatives: data.alternatives,
          commitment: data.commitment,
          certainty: data.certainty,
          provenance,
          promotionHistory: [],
          constrains: [],
          dependsOn: [],
          enables: [],
          manifestsIn: [],
          closedOptions: [],
        }

        this.store.appendEvent({
          type: 'NODE_CREATED',
          nodeType: 'decision',
          node: decision,
          provenance,
        }, context)

        return {
          operation: 'insert',
          targetLayer: 'decisions',
          nodeId: id,
          changes: { statement: data.statement, commitment: data.commitment },
        }
      }

      case 'constraint_stated': {
        const { data } = extracted
        const id = createId('constraint')
        const constraint: Constraint = {
          id,
          type: data.type,
          statement: data.statement,
          source: 'stated',
          hardness: data.hardness,
          certainty: data.certainty,
          provenance,
          originStatementTurn: turnIndex,
          propagatesTo: [],
          isRevealed: false,
          scope: 'project',
        }

        this.store.appendEvent({
          type: 'NODE_CREATED',
          nodeType: 'constraint',
          node: constraint,
          provenance,
        }, context)

        return {
          operation: 'insert',
          targetLayer: 'constraints',
          nodeId: id,
          changes: { statement: data.statement, type: data.type },
        }
      }

      case 'rejection': {
        const { data } = extracted
        const id = createId('rejection')
        const rejection: Rejection = {
          id,
          category: data.category,
          statement: data.statement,
          rejectionType: data.rejectionType,
          reason: data.reason,
          provenance,
          revivalCondition: data.revivalCondition ?? undefined,
          revealsPreference: data.revealsPreference ?? undefined,
          contributesToValues: data.contributesToValues,
        }

        this.store.appendEvent({
          type: 'NODE_CREATED',
          nodeType: 'rejection',
          node: rejection,
          provenance,
        }, context)

        return {
          operation: 'insert',
          targetLayer: 'rejections',
          nodeId: id,
          changes: { statement: data.statement, rejectionType: data.rejectionType },
        }
      }

      case 'exploration': {
        const { data } = extracted
        const id = createId('exploration')
        const exploration: Exploration = {
          id,
          topic: data.topic,
          direction: data.direction,
          openQuestions: data.openQuestions,
          consideredOptions: data.consideredOptions,
          provenance,
          resolutionCondition: data.resolutionCondition ?? undefined,
          status: 'active',
        }

        this.store.appendEvent({
          type: 'NODE_CREATED',
          nodeType: 'exploration',
          node: exploration,
          provenance,
        }, context)

        return {
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: id,
          changes: { topic: data.topic },
        }
      }

      case 'correction': {
        const { data } = extracted
        // Find the node being corrected by searching recent model state
        // For now, emit a CORRECTION_APPLIED event with the changes
        // The store will apply the correction to the matching node
        const model = this.store.getProjectModel(projectId)
        const targetNodeId = this.findCorrectionTarget(model, data.correcting)

        if (targetNodeId) {
          this.store.appendEvent({
            type: 'CORRECTION_APPLIED',
            targetNodeId,
            changes: { statement: data.correction },
            provenance,
          }, context)

          return {
            operation: 'update',
            targetLayer: 'decisions', // Best guess — corrections can target any layer
            nodeId: targetNodeId,
            changes: { correction: data.correction },
          }
        }

        return null
      }
    }
  }

  private findCorrectionTarget(model: ProjectModel, correcting: string): NodeId | null {
    const searchText = correcting.toLowerCase()

    // Search decisions
    for (const [id, dec] of model.decisions) {
      if (dec.statement.toLowerCase().includes(searchText) || searchText.includes(dec.statement.toLowerCase())) {
        return id
      }
    }
    // Search constraints
    for (const [id, con] of model.constraints) {
      if (con.statement.toLowerCase().includes(searchText) || searchText.includes(con.statement.toLowerCase())) {
        return id
      }
    }
    // Search explorations
    for (const [id, exp] of model.explorations) {
      if (exp.topic.toLowerCase().includes(searchText) || searchText.includes(exp.topic.toLowerCase())) {
        return id
      }
    }

    return null
  }

  private checkPromotionEligibility(
    extracted: ExtractedNode,
    projectId: NodeId,
    sessionId: string,
    turnIndex: number
  ): PromotionCheck | null {
    // Only decisions can be promoted
    if (extracted.turnType !== 'decision') return null

    const model = this.store.getProjectModel(projectId)

    // Check for decided → locked: does any decided decision have 3+ dependents?
    for (const [id, decision] of model.decisions) {
      if (decision.commitment !== 'decided') continue

      let dependentCount = 0
      for (const [, other] of model.decisions) {
        if (other.dependsOn.includes(id)) dependentCount++
      }

      if (dependentCount >= 3) {
        // Auto-promote decided → locked
        const provenance = createProvenance(sessionId, turnIndex, '', 'high')
        this.store.appendEvent({
          type: 'NODE_PROMOTED',
          nodeId: id,
          from: 'decided',
          to: 'locked',
          trigger: 'dependency_threshold',
          wasAutomatic: true,
          provenance,
        }, { projectId, sessionId, turnIndex })

        return {
          nodeId: id,
          currentCommitment: 'decided',
          candidatePromotion: 'locked',
          trigger: 'dependency_threshold',
          isAutomatic: true,
          requiresUserAction: false,
        }
      }
    }

    // CARDINAL RULE: leaning → decided is NEVER automatic
    // We can surface a suggestion but never auto-promote
    for (const [id, decision] of model.decisions) {
      if (decision.commitment !== 'leaning') continue

      // Count how many turns have referenced this decision without questioning it
      const turns = this.store.getSessionTurns(sessionId)
      // If strong signals exist, return a check that requiresUserAction
      // but do NOT auto-promote

      return {
        nodeId: id,
        currentCommitment: 'leaning',
        candidatePromotion: 'decided',
        trigger: 'return_without_question',
        isAutomatic: false,
        requiresUserAction: true, // ALWAYS true for leaning → decided
      }
    }

    return null
  }
}

// Need ProjectModel type for findCorrectionTarget
import type { ProjectModel } from '@gzoo/forge-core'
