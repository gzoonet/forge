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
  type Tension,
} from '@gzoo/forge-core'
import { ProjectModelStore } from '@gzoo/forge-store'
import type { LLMClient } from './llm-client'
import { classify } from './classifier'
import { extract, isExtractable, type ExtractedNode } from './extractor'
import { checkArtifactTrigger, generateSpecArtifact } from './artifact-engine'
import { checkPropagation, applyPropagationResults, constraintsMayConflict } from './constraint-engine'
import { TrustEngine } from './trust-engine'
import type { SurfacingDecision, MemoryMatch, SessionBrief } from '@gzoo/forge-core'
import { generateSessionBrief } from './session-brief'

export class ExtractionPipeline {
  private trustEngine: TrustEngine | null = null

  constructor(
    private store: ProjectModelStore,
    private llmClient: LLMClient
  ) {}

  initTrust(projectId: NodeId, sessionId: string): TrustEngine {
    this.trustEngine = new TrustEngine(this.store, projectId, sessionId)
    return this.trustEngine
  }

  getTrustEngine(): TrustEngine | null {
    return this.trustEngine
  }

  generateBrief(projectId: NodeId, sessionId: string, previousSessionId?: string): SessionBrief {
    const model = this.store.getProjectModel(projectId)
    return generateSessionBrief(model, this.store, sessionId, previousSessionId)
  }

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
    let extractionFailures = 0

    for (const turnType of allTypes) {
      if (!isExtractable(turnType)) continue

      const extracted = await extract(turnType, turn.text, recentContext, this.llmClient)
      if (!extracted) {
        extractionFailures++
        continue
      }

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

    // Check for exploration resolution (exploring → leaning promotion)
    const explorationResolutions = this.checkExplorationResolution(
      modelUpdates, projectId, turn.sessionId, turn.turnIndex, classification.confidence
    )
    for (const resolution of explorationResolutions) {
      modelUpdates.push(resolution.update)
      promotionChecks.push(resolution.promoCheck)
    }

    // Stage 2.5: Cross-project memory query for new decisions/explorations
    let memoryMatches: MemoryMatch[] = []
    const newDecisions = modelUpdates.filter(u => u.targetLayer === 'decisions' && u.operation === 'insert')
    const newExplorations = modelUpdates.filter(u => u.targetLayer === 'explorations' && u.operation === 'insert')

    if (newDecisions.length > 0 || newExplorations.length > 0) {
      try {
        const currentModel = this.store.getProjectModel(projectId)

        for (const update of newDecisions) {
          const decision = currentModel.decisions.get(update.nodeId)
          if (decision) {
            const result = this.store.queryMemory({
              currentDecision: decision.statement,
              categories: [decision.category],
              excludeProjectId: projectId,
            })
            memoryMatches.push(...result.matches)
          }
        }

        for (const update of newExplorations) {
          const exploration = currentModel.explorations.get(update.nodeId)
          if (exploration) {
            const result = this.store.queryMemory({
              currentExploration: exploration.topic,
              excludeProjectId: projectId,
            })
            memoryMatches.push(...result.matches)
          }
        }

        // Deduplicate by statement
        const seen = new Set<string>()
        memoryMatches = memoryMatches.filter(m => {
          if (seen.has(m.statement)) return false
          seen.add(m.statement)
          return true
        })
      } catch {
        // Memory query failure should not break the pipeline
      }
    }

    // Stage 3: Constraint propagation check for new decisions
    let escalationRequired = false
    let escalationReason: string | undefined
    let conflictChecksTriggered = false

    const decisionUpdates = modelUpdates.filter(u => u.targetLayer === 'decisions' && u.operation === 'insert')
    if (decisionUpdates.length > 0) {
      const currentModel = this.store.getProjectModel(projectId)

      for (const update of decisionUpdates) {
        const decision = currentModel.decisions.get(update.nodeId)
        if (!decision) continue

        // Only check propagation for committed decisions
        if (decision.commitment !== 'decided' && decision.commitment !== 'locked') continue

        try {
          const propagation = await checkPropagation(decision, currentModel, this.llmClient)

          if (propagation.tensions.length > 0 || propagation.closedOptions.length > 0) {
            conflictChecksTriggered = true
            const provenance = createProvenance(turn.sessionId, turn.turnIndex, turn.text, classification.confidence)
            const result = applyPropagationResults(
              propagation, decision, currentModel, this.store, provenance,
              { projectId, sessionId: turn.sessionId, turnIndex: turn.turnIndex }
            )

            for (const tensionId of result.tensionIds) {
              modelUpdates.push({
                operation: 'insert',
                targetLayer: 'tensions',
                nodeId: tensionId,
                changes: { type: 'constraint_propagation' },
              })
            }

            if (result.escalation) {
              escalationRequired = true
              escalationReason = result.escalation.reason
            }
          }
        } catch (err) {
          console.warn('[forge-extract] Constraint propagation check failed:', (err as Error).message)
        }
      }
    }

    // Detect intra-turn tensions between newly created constraints (and vs existing)
    const newConstraints = modelUpdates.filter(u => u.targetLayer === 'constraints' && u.operation === 'insert')
    if (newConstraints.length >= 1) {
      const currentModel = this.store.getProjectModel(projectId)
      const intraTurnTensions = this.detectIntraTurnTensions(
        newConstraints, currentModel, turn.sessionId, turn.turnIndex, classification.confidence
      )
      for (const tensionUpdate of intraTurnTensions) {
        modelUpdates.push(tensionUpdate)
        conflictChecksTriggered = true
      }
    }

    // Check if artifact generation should trigger
    if (modelUpdates.some(u => u.targetLayer === 'decisions')) {
      const currentModel = this.store.getProjectModel(projectId)
      const trigger = checkArtifactTrigger(currentModel)
      if (trigger.shouldGenerate) {
        try {
          const artifact = await generateSpecArtifact(
            currentModel, this.store, this.llmClient,
            turn.sessionId, turn.turnIndex
          )
          modelUpdates.push({
            operation: 'insert',
            targetLayer: 'artifacts',
            nodeId: artifact.id,
            changes: { name: artifact.name, type: 'spec', status: 'draft' },
          })
        } catch (err) {
          // Artifact generation failure should not break the pipeline
          console.warn('[forge-extract] Artifact generation failed:', (err as Error).message)
        }
      }
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 500) {
      console.warn(`[forge-extract] Turn ${turn.turnIndex} took ${elapsed}ms (target: 500ms)`)
    }

    const result: ExtractionResult = {
      turnRef: { sessionId: turn.sessionId, turnIndex: turn.turnIndex },
      classifications: [{ type: classification.primary, confidence: classification.confidence, additionalTypes: classification.additional }],
      modelUpdates,
      promotionChecks,
      constraintChecksTriggered: conflictChecksTriggered || modelUpdates.some(u =>
        u.targetLayer === 'constraints' || u.targetLayer === 'decisions'
      ),
      conflictChecksTriggered,
      escalationRequired,
      escalationReason,
      memoryMatches: memoryMatches.length > 0 ? memoryMatches : undefined,
      extractionFailures: extractionFailures > 0 ? extractionFailures : undefined,
    }

    // Stage 4: Trust calibration — decide what to surface
    if (this.trustEngine) {
      this.trustEngine.updateFlowState(turn.turnIndex, result)
      const currentModel = this.store.getProjectModel(projectId)
      const surfacingDecisions = this.trustEngine.evaluateSurfacings(
        turn.turnIndex, result, currentModel
      )
      result.surfacingDecisions = surfacingDecisions

      // Auto-record surfacings that passed all gates
      for (const sd of surfacingDecisions) {
        if (sd.shouldSurface && sd.suggestedMessage && sd.type) {
          const nodeIds = sd.targetNodeIds ?? []
          this.trustEngine.recordSurfacing(sd.type, turn.turnIndex, nodeIds, sd.suggestedMessage)
        }
      }
    }

    return result
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
        // Find the node being corrected using scored matching
        const model = this.store.getProjectModel(projectId)
        const targetNodeId = this.findTargetNode(model, data.correcting, data.targetType)

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

      case 'approval': {
        const { data } = extracted
        if (!data.targetDescription) return null
        const model = this.store.getProjectModel(projectId)
        const targetNodeId = this.findTargetNode(model, data.targetDescription, 'decision')

        if (targetNodeId && data.promotionIntent) {
          const decision = model.decisions.get(targetNodeId)
          if (decision && decision.commitment === 'leaning') {
            // This is the ONE valid path for leaning → decided: explicit user approval
            this.store.appendEvent({
              type: 'NODE_PROMOTED',
              nodeId: targetNodeId,
              from: 'leaning',
              to: 'decided',
              trigger: 'explicit_commitment',
              wasAutomatic: false,
              provenance,
            }, context)

            return {
              operation: 'promote' as any,
              targetLayer: 'decisions',
              nodeId: targetNodeId,
              changes: { commitment: 'decided', trigger: 'explicit_commitment' },
            }
          }
        }

        // Non-promotion approval — acknowledge but no model change needed
        if (targetNodeId) {
          return {
            operation: 'update',
            targetLayer: 'decisions',
            nodeId: targetNodeId,
            changes: { approved: true },
          }
        }

        return null
      }

      case 'elaboration': {
        const { data } = extracted
        if (!data.targetDescription) return null
        const model = this.store.getProjectModel(projectId)
        const targetNodeId = this.findTargetNode(model, data.targetDescription)

        if (!targetNodeId) return null

        // Determine which layer the node is in and build changes
        const changes: Record<string, unknown> = {}

        // Check if it's a decision
        const decision = model.decisions.get(targetNodeId)
        if (decision) {
          if (data.additions.length > 0) {
            const newRationale = decision.rationale
              ? `${decision.rationale}; ${data.additions.join('; ')}`
              : data.additions.join('; ')
            changes.rationale = newRationale
          }
          if (data.modifies) Object.assign(changes, data.modifies)

          this.store.appendEvent({
            type: 'NODE_UPDATED',
            nodeId: targetNodeId,
            nodeType: 'decision',
            changes,
            provenance,
          }, context)

          return {
            operation: 'update',
            targetLayer: 'decisions',
            nodeId: targetNodeId,
            changes,
          }
        }

        // Check if it's an exploration
        const exploration = model.explorations.get(targetNodeId)
        if (exploration) {
          if (data.additions.length > 0) {
            changes.consideredOptions = [...exploration.consideredOptions, ...data.additions]
          }
          if (data.modifies) Object.assign(changes, data.modifies)

          this.store.appendEvent({
            type: 'NODE_UPDATED',
            nodeId: targetNodeId,
            nodeType: 'exploration',
            changes,
            provenance,
          }, context)

          return {
            operation: 'update',
            targetLayer: 'explorations',
            nodeId: targetNodeId,
            changes,
          }
        }

        // Check if it's a constraint
        const constraint = model.constraints.get(targetNodeId)
        if (constraint) {
          if (data.modifies) Object.assign(changes, data.modifies)
          if (data.additions.length > 0) {
            changes.statement = `${constraint.statement}; ${data.additions.join('; ')}`
          }

          this.store.appendEvent({
            type: 'NODE_UPDATED',
            nodeId: targetNodeId,
            nodeType: 'constraint',
            changes,
            provenance,
          }, context)

          return {
            operation: 'update',
            targetLayer: 'constraints',
            nodeId: targetNodeId,
            changes,
          }
        }

        return null
      }
    }
  }

  private findTargetNode(
    model: ProjectModel,
    searchText: string,
    preferLayer?: 'decision' | 'constraint' | 'exploration' | null
  ): NodeId | null {
    const STOPWORDS = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that',
      'this', 'it', 'its', 'not', 'but', 'and', 'or', 'if', 'we', 'our',
      'use', 'using', 'want', 'need', 'said', 'also',
    ])

    const tokenize = (text: string): Set<string> => {
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w))
      return new Set(words)
    }

    const jaccard = (a: Set<string>, b: Set<string>): number => {
      if (a.size === 0 || b.size === 0) return 0
      let intersection = 0
      for (const w of a) { if (b.has(w)) intersection++ }
      const union = a.size + b.size - intersection
      return union > 0 ? intersection / union : 0
    }

    const searchTokens = tokenize(searchText)
    if (searchTokens.size === 0) return null

    // Short search text needs higher threshold to avoid false positives
    const threshold = searchTokens.size <= 2 ? 0.4 : 0.25

    type Candidate = { id: NodeId; score: number; turnIndex: number }
    const candidates: Candidate[] = []

    const addCandidates = (
      map: Map<string, { statement?: string; topic?: string; provenance: { turnIndex: number } }>,
      layer: string
    ) => {
      if (preferLayer && layer !== preferLayer) return
      for (const [id, node] of map) {
        const text = (node as any).statement ?? (node as any).topic ?? ''
        const score = jaccard(searchTokens, tokenize(text))
        if (score >= threshold) {
          candidates.push({ id, score, turnIndex: node.provenance.turnIndex })
        }
      }
    }

    addCandidates(model.decisions as any, 'decision')
    addCandidates(model.constraints as any, 'constraint')
    addCandidates(model.explorations as any, 'exploration')

    if (candidates.length === 0) return null

    // Sort by score desc, then by recency (higher turnIndex) desc
    candidates.sort((a, b) => b.score - a.score || b.turnIndex - a.turnIndex)
    return candidates[0].id
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

  private detectIntraTurnTensions(
    newConstraintUpdates: ModelUpdate[],
    model: ProjectModel,
    sessionId: string,
    turnIndex: number,
    confidence: 'high' | 'medium' | 'low'
  ): ModelUpdate[] {
    const results: ModelUpdate[] = []
    const provenance = createProvenance(sessionId, turnIndex, '', confidence)

    // Get the newly created constraints
    const newConstraints: Constraint[] = []
    for (const update of newConstraintUpdates) {
      const c = model.constraints.get(update.nodeId)
      if (c) newConstraints.push(c)
    }

    // Check new constraints against each other
    for (let i = 0; i < newConstraints.length; i++) {
      for (let j = i + 1; j < newConstraints.length; j++) {
        if (constraintsMayConflict(newConstraints[i], newConstraints[j])) {
          const tensionId = createId('tension')
          const tension: Tension = {
            id: tensionId,
            description: `Potential conflict between "${newConstraints[i].statement}" and "${newConstraints[j].statement}"`,
            nodeAId: newConstraints[i].id,
            nodeBId: newConstraints[j].id,
            nodeAType: 'constraint',
            nodeBType: 'constraint',
            severity: 'significant',
            detectedAt: new Date(),
            provenance,
            status: 'active',
          }

          this.store.appendEvent({
            type: 'NODE_CREATED',
            nodeType: 'tension',
            node: tension,
            provenance,
          }, { projectId: model.id, sessionId, turnIndex })

          results.push({
            operation: 'insert',
            targetLayer: 'tensions',
            nodeId: tensionId,
            changes: { type: 'intra_turn_conflict' },
          })
        }
      }
    }

    // Check new constraints against existing constraints
    const existingConstraints = Array.from(model.constraints.values()).filter(
      c => !newConstraintUpdates.some(u => u.nodeId === c.id)
    )
    for (const newC of newConstraints) {
      for (const existC of existingConstraints) {
        if (constraintsMayConflict(newC, existC)) {
          const tensionId = createId('tension')
          const tension: Tension = {
            id: tensionId,
            description: `New constraint "${newC.statement}" may conflict with existing "${existC.statement}"`,
            nodeAId: newC.id,
            nodeBId: existC.id,
            nodeAType: 'constraint',
            nodeBType: 'constraint',
            severity: 'significant',
            detectedAt: new Date(),
            provenance,
            status: 'active',
          }

          this.store.appendEvent({
            type: 'NODE_CREATED',
            nodeType: 'tension',
            node: tension,
            provenance,
          }, { projectId: model.id, sessionId, turnIndex })

          results.push({
            operation: 'insert',
            targetLayer: 'tensions',
            nodeId: tensionId,
            changes: { type: 'intra_turn_conflict' },
          })
        }
      }
    }

    return results
  }

  private checkExplorationResolution(
    modelUpdates: ModelUpdate[],
    projectId: NodeId,
    sessionId: string,
    turnIndex: number,
    confidence: 'high' | 'medium' | 'low'
  ): Array<{ update: ModelUpdate; promoCheck: PromotionCheck }> {
    const results: Array<{ update: ModelUpdate; promoCheck: PromotionCheck }> = []
    const model = this.store.getProjectModel(projectId)

    // Check 1: Did a rejection eliminate an option from an active exploration?
    const newRejections = modelUpdates.filter(u => u.targetLayer === 'rejections' && u.operation === 'insert')
    if (newRejections.length === 0) return results

    for (const [expId, exploration] of model.explorations) {
      if (exploration.status !== 'active') continue
      if (exploration.consideredOptions.length < 2) continue

      // Check if the rejection matches any considered option
      for (const rejUpdate of newRejections) {
        const rejection = model.rejections.get(rejUpdate.nodeId)
        if (!rejection) continue

        const rejLower = rejection.statement.toLowerCase()
        const matchingOption = exploration.consideredOptions.find(opt =>
          rejLower.includes(opt.toLowerCase()) || opt.toLowerCase().includes(rejection.statement.toLowerCase().slice(0, 20))
        )

        if (!matchingOption) continue

        // Remove the rejected option
        const remainingOptions = exploration.consideredOptions.filter(opt => opt !== matchingOption)

        if (remainingOptions.length === 1) {
          // Only one option survives — auto-create a leaning decision
          const survivingOption = remainingOptions[0]
          const decId = createId('decision')
          const provenance = createProvenance(sessionId, turnIndex, '', confidence)

          const decision: Decision = {
            id: decId,
            category: (rejection.category as any) ?? 'technical',
            statement: survivingOption,
            rationale: `Remaining option after rejecting "${matchingOption}"`,
            alternatives: [],
            commitment: 'leaning',
            certainty: 'uncertain',
            provenance,
            promotionHistory: [{
              from: 'exploring' as CommitmentLevel,
              to: 'leaning' as CommitmentLevel,
              trigger: 'comparative_preference' as any,
              wasAutomatic: true,
              sessionId,
              turnIndex,
              promotedAt: new Date(),
            }],
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
          }, { projectId, sessionId, turnIndex })

          // Resolve the exploration
          this.store.appendEvent({
            type: 'NODE_UPDATED',
            nodeId: expId,
            nodeType: 'exploration',
            changes: { status: 'resolved' },
            provenance,
          }, { projectId, sessionId, turnIndex })

          results.push({
            update: {
              operation: 'insert',
              targetLayer: 'decisions',
              nodeId: decId,
              changes: { statement: survivingOption, commitment: 'leaning' },
            },
            promoCheck: {
              nodeId: decId,
              currentCommitment: 'exploring' as CommitmentLevel,
              candidatePromotion: 'leaning' as CommitmentLevel,
              trigger: 'comparative_preference',
              isAutomatic: true,
              requiresUserAction: false,
            },
          })
        }
      }
    }

    return results
  }
}

// Need ProjectModel type for findCorrectionTarget
import type { ProjectModel } from '@gzoo/forge-core'
