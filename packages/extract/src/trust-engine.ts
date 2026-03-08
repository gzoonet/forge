import type {
  NodeId,
  ProjectModel,
  ExtractionResult,
  FlowState,
  InterruptionBudget,
  SurfacingDecision,
  SurfacingType,
  SurfacingEvent,
  TrustMetrics,
  Decision,
  Tension,
} from '@gzoo/forge-core'
import type { ProjectModelStore } from '@gzoo/forge-store'

// ── Flow Detection ──────────────────────────────────────────────────────────

const FLOW_THRESHOLD = 3           // Consecutive productive turns to enter flow
const COOLDOWN_TURNS = 3           // Min turns between interruptions
const MAX_INTERRUPTIONS = 5        // Per session default
const FLOW_BREAK_PENALTY = 2       // Extra cooldown after breaking flow

export class TrustEngine {
  private flowState: FlowState
  private budget: InterruptionBudget
  private suppressedCount = 0
  private scopeDriftTurnCount = 0
  private scopeDriftConfirmedTopics: Set<string> = new Set()

  constructor(
    private store: ProjectModelStore,
    private projectId: NodeId,
    private sessionId: string
  ) {
    this.flowState = {
      isInFlow: false,
      consecutiveProductiveTurns: 0,
      lastInterruptionTurn: -COOLDOWN_TURNS, // Allow first surfacing immediately
      turnsSinceInterruption: COOLDOWN_TURNS,
      sessionStartTurn: 0,
    }
    this.budget = {
      maxInterruptionsPerSession: MAX_INTERRUPTIONS,
      interruptionsUsed: 0,
      remainingBudget: MAX_INTERRUPTIONS,
      cooldownTurns: COOLDOWN_TURNS,
    }
  }

  // ── Update Flow State After Each Turn ───────────────────────────────────

  updateFlowState(turnIndex: number, result: ExtractionResult): void {
    const isProductive = this.isProductiveTurn(result)

    if (isProductive) {
      this.flowState.consecutiveProductiveTurns++
    } else {
      this.flowState.consecutiveProductiveTurns = 0
    }

    this.flowState.isInFlow = this.flowState.consecutiveProductiveTurns >= FLOW_THRESHOLD
    this.flowState.turnsSinceInterruption = turnIndex - this.flowState.lastInterruptionTurn
  }

  // ── Core Decision: Should We Surface This? ──────────────────────────────

  shouldSurface(
    type: SurfacingType,
    targetNodeIds: NodeId[],
    turnIndex: number,
    model: ProjectModel
  ): SurfacingDecision {
    // Critical items always surface (blocking tensions, locked notifications)
    const priority = this.getPriority(type, model, targetNodeIds)

    if (priority === 'critical') {
      return { shouldSurface: true, reason: 'Critical surfacing — always shown', priority }
    }

    // Check deduplication — have we already surfaced this?
    if (this.store.hasSurfacedForNodes(this.sessionId, type, targetNodeIds)) {
      this.suppressedCount++
      return {
        shouldSurface: false,
        reason: 'Already surfaced this session',
        priority,
        suppressedBecause: 'deduplication',
      }
    }

    // Check budget — are we out of interruptions?
    if (this.budget.remainingBudget <= 0 && priority !== 'high') {
      this.suppressedCount++
      return {
        shouldSurface: false,
        reason: 'Interruption budget exhausted',
        priority,
        suppressedBecause: 'budget_exhausted',
      }
    }

    // Check cooldown — too soon after last interruption?
    const effectiveCooldown = this.flowState.isInFlow
      ? this.budget.cooldownTurns + FLOW_BREAK_PENALTY
      : this.budget.cooldownTurns

    if (this.flowState.turnsSinceInterruption < effectiveCooldown && priority === 'low') {
      this.suppressedCount++
      return {
        shouldSurface: false,
        reason: `Cooldown active (${effectiveCooldown - this.flowState.turnsSinceInterruption} turns remaining)`,
        priority,
        suppressedBecause: 'cooldown',
      }
    }

    // Check flow state — in flow, only high+ priority interrupts
    if (this.flowState.isInFlow && priority === 'medium') {
      this.suppressedCount++
      return {
        shouldSurface: false,
        reason: 'User is in flow — suppressing medium-priority surfacing',
        priority,
        suppressedBecause: 'flow_protection',
      }
    }

    // Generate the message
    const suggestedMessage = this.buildMessage(type, targetNodeIds, model)

    return {
      shouldSurface: true,
      reason: `Passed all gates (priority: ${priority})`,
      priority,
      suggestedMessage,
    }
  }

  // ── Record That We Surfaced Something ───────────────────────────────────

  recordSurfacing(
    type: SurfacingType,
    turnIndex: number,
    targetNodeIds: NodeId[],
    message: string
  ): SurfacingEvent {
    this.flowState.lastInterruptionTurn = turnIndex
    this.flowState.turnsSinceInterruption = 0
    this.budget.interruptionsUsed++
    this.budget.remainingBudget--

    // Breaking flow has extra cost
    if (this.flowState.isInFlow) {
      this.flowState.isInFlow = false
      this.flowState.consecutiveProductiveTurns = 0
    }

    return this.store.recordSurfacing({
      type,
      sessionId: this.sessionId,
      projectId: this.projectId,
      turnIndex,
      targetNodeIds,
      message,
    })
  }

  // ── Evaluate What Needs Surfacing After a Turn ──────────────────────────

  evaluateSurfacings(
    turnIndex: number,
    result: ExtractionResult,
    model: ProjectModel
  ): SurfacingDecision[] {
    const decisions: SurfacingDecision[] = []

    // 1. Promotion suggestions (leaning → decided)
    for (const check of result.promotionChecks) {
      if (check.requiresUserAction) {
        const nodeIds = [check.nodeId]
        const decision = this.shouldSurface('promotion_suggestion', nodeIds, turnIndex, model)
        decision.type = 'promotion_suggestion'
        decision.targetNodeIds = nodeIds
        if (decision.shouldSurface) {
          const node = model.decisions.get(check.nodeId)
          if (node) {
            decision.suggestedMessage = buildPromotionMessage(node)
          }
        }
        decisions.push(decision)
      }
    }

    // 2. Escalations (constraint propagation)
    if (result.escalationRequired) {
      const tensionUpdates = result.modelUpdates.filter(u => u.targetLayer === 'tensions')
      const tensionIds = tensionUpdates.map(u => u.nodeId)
      const decision = this.shouldSurface('escalation', tensionIds, turnIndex, model)
      decision.type = 'escalation'
      decision.targetNodeIds = tensionIds
      if (decision.shouldSurface && result.escalationReason) {
        decision.suggestedMessage = result.escalationReason
      }
      decisions.push(decision)
    }

    // 3. Non-escalation tensions
    const newTensions = result.modelUpdates
      .filter(u => u.targetLayer === 'tensions' && u.operation === 'insert')
    if (newTensions.length > 0 && !result.escalationRequired) {
      const tensionIds = newTensions.map(u => u.nodeId)
      const decision = this.shouldSurface('tension_detected', tensionIds, turnIndex, model)
      decision.type = 'tension_detected'
      decision.targetNodeIds = tensionIds
      if (decision.shouldSurface) {
        const tensionDescs = tensionIds
          .map(id => model.tensions.get(id)?.description)
          .filter(Boolean)
        decision.suggestedMessage = tensionDescs.length === 1
          ? tensionDescs[0]!
          : `${tensionDescs.length} tensions detected. Run: forge tensions`
      }
      decisions.push(decision)
    }

    // 4. Scope drift detection
    const scopeDrift = this.detectScopeDrift(result, model)
    if (scopeDrift) {
      const decision = this.shouldSurface('scope_drift', scopeDrift.nodeIds, turnIndex, model)
      decision.type = 'scope_drift'
      decision.targetNodeIds = scopeDrift.nodeIds
      if (decision.shouldSurface) {
        decision.suggestedMessage = scopeDrift.message
      }
      decisions.push(decision)
    }

    return decisions
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  getFlowState(): FlowState {
    return { ...this.flowState }
  }

  getBudget(): InterruptionBudget {
    return { ...this.budget }
  }

  getSuppressedCount(): number {
    return this.suppressedCount
  }

  getMetrics(): TrustMetrics {
    const metrics = this.store.getTrustMetrics(this.sessionId)
    metrics.suppressedSurfacings = this.suppressedCount
    return metrics
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private isProductiveTurn(result: ExtractionResult): boolean {
    // A turn is productive if it generated model updates and wasn't a correction
    if (result.modelUpdates.length === 0) return false
    const hasCorrection = result.classifications.some(c => c.type === 'correction')
    return !hasCorrection
  }

  private getPriority(
    type: SurfacingType,
    model: ProjectModel,
    targetNodeIds: NodeId[]
  ): 'critical' | 'high' | 'medium' | 'low' {
    switch (type) {
      case 'escalation': {
        // Check tension severity — blocking = critical, significant = high
        const tensions = targetNodeIds
          .map(id => model.tensions.get(id))
          .filter((t): t is Tension => t != null)
        if (tensions.some(t => t.severity === 'blocking')) return 'critical'
        if (tensions.some(t => t.severity === 'significant')) return 'high'
        return 'medium'
      }
      case 'locked_notification':
        return 'high' // Always notify about locked decisions
      case 'scope_drift':
        return 'medium'
      case 'promotion_suggestion':
        return 'low' // Wait for natural moment
      case 'tension_detected':
        return 'medium'
      case 'artifact_ready':
        return 'low' // Don't break flow for artifacts
      case 'constraint_conflict':
        return 'high'
      case 'session_brief':
        return 'critical' // Always show on session start
    }
  }

  private buildMessage(
    type: SurfacingType,
    targetNodeIds: NodeId[],
    model: ProjectModel
  ): string {
    switch (type) {
      case 'promotion_suggestion': {
        const dec = model.decisions.get(targetNodeIds[0])
        return dec ? buildPromotionMessage(dec) : 'A decision may be ready to commit.'
      }
      case 'locked_notification': {
        const dec = model.decisions.get(targetNodeIds[0])
        if (!dec) return 'A decision is now locked.'
        const depCount = this.countDependents(dec.id, model)
        return `"${dec.statement}" is now load-bearing — ${depCount} other decisions depend on it. Changing it would affect downstream work. Just flagging so you know the weight of it.`
      }
      case 'tension_detected': {
        const tension = model.tensions.get(targetNodeIds[0])
        return tension?.description ?? 'A new tension was detected.'
      }
      case 'scope_drift':
        return 'Recent additions may expand the defined scope.'
      case 'artifact_ready':
        return 'An artifact draft is ready for review.'
      default:
        return ''
    }
  }

  private countDependents(decisionId: NodeId, model: ProjectModel): number {
    let count = 0
    for (const [, dec] of model.decisions) {
      if (dec.dependsOn.includes(decisionId)) count++
    }
    return count
  }

  confirmScopeExpansion(topic: string): void {
    this.scopeDriftConfirmedTopics.add(topic.toLowerCase())
    this.scopeDriftTurnCount = 0
  }

  private detectScopeDrift(
    result: ExtractionResult,
    model: ProjectModel
  ): { nodeIds: NodeId[]; message: string } | null {
    // Only check if we have a defined scope
    if (!model.intent.primaryGoal) return null
    if (model.intent.scope.inScope.length === 0 && model.intent.scope.outOfScope.length === 0) return null

    // Look for new explorations or decisions that might be out of scope
    const newItems = result.modelUpdates
      .filter(u => (u.targetLayer === 'explorations' || u.targetLayer === 'decisions') && u.operation === 'insert')

    if (newItems.length === 0) return null

    // Check 1: Overlap with explicit outOfScope items
    const outOfScopeKeywords = model.intent.scope.outOfScope
      .flatMap(s => s.description.toLowerCase().split(/\s+/).filter(w => w.length > 4))

    // Check 2: Low overlap with inScope items (drift into genuinely new territory)
    const inScopeKeywords = model.intent.scope.inScope
      .flatMap(s => s.description.toLowerCase().split(/\s+/).filter(w => w.length > 4))
    const goalKeywords = model.intent.primaryGoal.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
    const allScopeKeywords = [...new Set([...inScopeKeywords, ...goalKeywords])]

    for (const update of newItems) {
      const node = model.explorations.get(update.nodeId) ?? model.decisions.get(update.nodeId)
      if (!node) continue
      const nodeText = (node as any).topic ?? (node as any).statement ?? ''
      const nodeWords = nodeText.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4)

      // Skip if this topic was already confirmed as in-scope
      if (this.scopeDriftConfirmedTopics.has(nodeText.toLowerCase())) continue

      let isDrift = false

      // Check against outOfScope (explicit)
      const outOfScopeOverlap = nodeWords.filter((w: string) => outOfScopeKeywords.includes(w))
      if (outOfScopeOverlap.length >= 2) {
        isDrift = true
      }

      // Check against inScope + goal (implicit — low overlap means potential drift)
      if (!isDrift && allScopeKeywords.length > 0 && nodeWords.length > 0) {
        const inScopeOverlap = nodeWords.filter((w: string) => allScopeKeywords.includes(w))
        const overlapRatio = inScopeOverlap.length / nodeWords.length
        if (overlapRatio < 0.15 && nodeWords.length >= 3) {
          isDrift = true
        }
      }

      if (isDrift) {
        this.scopeDriftTurnCount++

        // Only flag after 2+ scope-expanding turns (per behavioral contract 7.2)
        if (this.scopeDriftTurnCount >= 2) {
          const scopeDesc = model.intent.primaryGoal.statement
          return {
            nodeIds: [update.nodeId],
            message: `These topics are a meaningful expansion from the defined scope ("${scopeDesc}"). Are we expanding scope, or is this a v2 idea to hold separately?`,
          }
        }
      }
    }

    return null
  }
}

// ── Message Builders ──────────────────────────────────────────────────────────

function buildPromotionMessage(decision: Decision): string {
  return `You've been leaning toward "${decision.statement}" across several points. Want to commit to that so I can start building around it?`
}
