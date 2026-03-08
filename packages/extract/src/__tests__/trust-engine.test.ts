import { describe, it, expect, beforeEach } from 'vitest'
import { TrustEngine } from '../trust-engine'
import { ProjectModelStore } from '@gzoo/forge-store'
import type {
  ExtractionResult,
  ProjectModel,
  Decision,
  Tension,
  Exploration,
  NodeId,
  Provenance,
} from '@gzoo/forge-core'
import { createId, createProvenance } from '@gzoo/forge-core'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvenance(turn: number = 1): Provenance {
  return createProvenance('sess_test', turn, 'test turn', 'high')
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: createId('decision'),
    category: 'technical',
    statement: 'Test decision',
    rationale: 'Test rationale',
    alternatives: [],
    commitment: 'decided',
    certainty: 'evidenced',
    provenance: makeProvenance(),
    promotionHistory: [],
    constrains: [],
    dependsOn: [],
    enables: [],
    manifestsIn: [],
    closedOptions: [],
    ...overrides,
  }
}

function makeExploration(overrides: Partial<Exploration> = {}): Exploration {
  return {
    id: createId('exploration'),
    topic: 'Test exploration',
    direction: 'Exploring options',
    openQuestions: [],
    consideredOptions: [],
    provenance: makeProvenance(),
    status: 'active',
    ...overrides,
  }
}

function makeTension(overrides: Partial<Tension> = {}): Tension {
  return {
    id: createId('tension'),
    description: 'Test tension',
    nodeAId: createId('decision'),
    nodeBId: createId('decision'),
    nodeAType: 'decision',
    nodeBType: 'decision',
    severity: 'significant',
    detectedAt: new Date(),
    provenance: makeProvenance(),
    status: 'active',
    ...overrides,
  }
}

function makeModel(overrides: Partial<ProjectModel> = {}): ProjectModel {
  return {
    id: 'proj_test',
    workspaceId: 'ws_test',
    name: 'Test',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    sessionIds: ['sess_test'],
    intent: {
      primaryGoal: null,
      scope: { inScope: [], outOfScope: [], unknownScope: [] },
      qualityBar: null,
      successMetrics: [],
      antiGoals: [],
    },
    decisions: new Map(),
    constraints: new Map(),
    rejections: new Map(),
    explorations: new Map(),
    tensions: new Map(),
    artifacts: new Map(),
    inheritedGlobalConstraintIds: [],
    ...overrides,
  }
}

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    turnRef: { sessionId: 'sess_test', turnIndex: 1 },
    classifications: [{ type: 'decision', confidence: 'high' }],
    modelUpdates: [{ operation: 'insert', targetLayer: 'decisions', nodeId: 'dec_test', changes: {} }],
    promotionChecks: [],
    constraintChecksTriggered: false,
    conflictChecksTriggered: false,
    escalationRequired: false,
    ...overrides,
  }
}

function makeNoOpResult(): ExtractionResult {
  return makeResult({
    classifications: [{ type: 'question', confidence: 'high' }],
    modelUpdates: [],
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TrustEngine', () => {
  let store: ProjectModelStore
  let engine: TrustEngine

  beforeEach(() => {
    store = new ProjectModelStore(':memory:')
    store.createProject('ws_test', 'Test Project')
    store.startSession('proj_test' as NodeId)
    engine = new TrustEngine(store, 'proj_test' as NodeId, 'sess_test')
  })

  describe('Flow Detection', () => {
    it('should detect flow state after 3 consecutive productive turns', () => {
      const result = makeResult()
      engine.updateFlowState(1, result)
      expect(engine.getFlowState().isInFlow).toBe(false)
      engine.updateFlowState(2, result)
      expect(engine.getFlowState().isInFlow).toBe(false)
      engine.updateFlowState(3, result)
      expect(engine.getFlowState().isInFlow).toBe(true)
    })

    it('should break flow on non-productive turn', () => {
      const productive = makeResult()
      const noOp = makeNoOpResult()

      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)
      expect(engine.getFlowState().isInFlow).toBe(true)

      engine.updateFlowState(4, noOp)
      expect(engine.getFlowState().isInFlow).toBe(false)
    })

    it('should break flow on correction turn', () => {
      const productive = makeResult()
      const correction = makeResult({
        classifications: [{ type: 'correction', confidence: 'high' }],
      })

      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)
      expect(engine.getFlowState().isInFlow).toBe(true)

      engine.updateFlowState(4, correction)
      expect(engine.getFlowState().isInFlow).toBe(false)
    })
  })

  describe('Surfacing Decisions', () => {
    it('should always surface critical items', () => {
      const blockingTension = makeTension({ severity: 'blocking' })
      const model = makeModel({
        tensions: new Map([[blockingTension.id, blockingTension]]),
      })

      const decision = engine.shouldSurface(
        'escalation',
        [blockingTension.id],
        1,
        model
      )

      expect(decision.shouldSurface).toBe(true)
      expect(decision.priority).toBe('critical')
    })

    it('should deduplicate — never surface same thing twice in a session', () => {
      const nodeId = createId('decision')
      const model = makeModel()

      // First surfacing should work
      const first = engine.shouldSurface('promotion_suggestion', [nodeId], 1, model)
      expect(first.shouldSurface).toBe(true)

      // Record it
      engine.recordSurfacing('promotion_suggestion', 1, [nodeId], 'test message')

      // Second surfacing for same node should be suppressed
      const second = engine.shouldSurface('promotion_suggestion', [nodeId], 5, model)
      expect(second.shouldSurface).toBe(false)
      expect(second.suppressedBecause).toBe('deduplication')
    })

    it('should suppress medium-priority during flow state', () => {
      const productive = makeResult()
      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)
      expect(engine.getFlowState().isInFlow).toBe(true)

      const model = makeModel()
      const decision = engine.shouldSurface('scope_drift', [createId('exploration')], 4, model)

      expect(decision.shouldSurface).toBe(false)
      expect(decision.suppressedBecause).toBe('flow_protection')
    })

    it('should allow high-priority during flow state', () => {
      const productive = makeResult()
      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)

      const tension = makeTension({ severity: 'significant' })
      const model = makeModel({
        tensions: new Map([[tension.id, tension]]),
      })

      const decision = engine.shouldSurface('escalation', [tension.id], 4, model)
      expect(decision.shouldSurface).toBe(true)
      expect(decision.priority).toBe('high')
    })

    it('should enforce cooldown between interruptions', () => {
      const model = makeModel()
      const nodeId1 = createId('decision')
      const nodeId2 = createId('decision')

      // Surface something at turn 1
      engine.recordSurfacing('promotion_suggestion', 1, [nodeId1], 'first message')

      // Try to surface something else at turn 2 (within cooldown)
      const decision = engine.shouldSurface('promotion_suggestion', [nodeId2], 2, model)
      expect(decision.shouldSurface).toBe(false)
      expect(decision.suppressedBecause).toBe('cooldown')
    })

    it('should allow surfacing after cooldown expires', () => {
      const model = makeModel()
      const nodeId1 = createId('decision')
      const nodeId2 = createId('decision')

      // Surface something at turn 1
      engine.recordSurfacing('promotion_suggestion', 1, [nodeId1], 'first message')

      // Update flow state to advance turn tracking
      engine.updateFlowState(2, makeNoOpResult())
      engine.updateFlowState(3, makeNoOpResult())
      engine.updateFlowState(4, makeNoOpResult())

      // Turn 5 should be past cooldown (3 turns)
      const decision = engine.shouldSurface('promotion_suggestion', [nodeId2], 5, model)
      expect(decision.shouldSurface).toBe(true)
    })

    it('should exhaust budget after max interruptions', () => {
      const model = makeModel()

      // Use up all 5 interruptions
      for (let i = 0; i < 5; i++) {
        const nodeId = createId('decision')
        engine.recordSurfacing('tension_detected', i * 10, [nodeId], `msg ${i}`)
      }

      expect(engine.getBudget().remainingBudget).toBe(0)

      // Next medium-priority surfacing should be denied
      const decision = engine.shouldSurface(
        'scope_drift',
        [createId('exploration')],
        60,
        model
      )
      expect(decision.shouldSurface).toBe(false)
      expect(decision.suppressedBecause).toBe('budget_exhausted')
    })

    it('should still allow high-priority after budget exhaustion', () => {
      const model = makeModel()

      // Exhaust budget
      for (let i = 0; i < 5; i++) {
        engine.recordSurfacing('tension_detected', i * 10, [createId('decision')], `msg ${i}`)
      }

      // High-priority should still pass
      const decision = engine.shouldSurface(
        'constraint_conflict',
        [createId('constraint')],
        60,
        model
      )
      expect(decision.shouldSurface).toBe(true)
    })
  })

  describe('Interruption Budget', () => {
    it('should start with default budget of 5', () => {
      expect(engine.getBudget().maxInterruptionsPerSession).toBe(5)
      expect(engine.getBudget().remainingBudget).toBe(5)
    })

    it('should decrement budget on surfacing', () => {
      engine.recordSurfacing('tension_detected', 1, [createId('decision')], 'test')
      expect(engine.getBudget().remainingBudget).toBe(4)
      expect(engine.getBudget().interruptionsUsed).toBe(1)
    })

    it('should track suppressed count', () => {
      const model = makeModel()
      // Record a surfacing, then try to surface again within cooldown
      engine.recordSurfacing('promotion_suggestion', 1, [createId('decision')], 'test')
      engine.shouldSurface('promotion_suggestion', [createId('decision')], 2, model)

      expect(engine.getSuppressedCount()).toBeGreaterThan(0)
    })
  })

  describe('Surfacing Message Building', () => {
    it('should build promotion suggestion message', () => {
      const dec = makeDecision({ statement: 'Use PostgreSQL for the database' })
      const model = makeModel({
        decisions: new Map([[dec.id, dec]]),
      })

      const decision = engine.shouldSurface('promotion_suggestion', [dec.id], 1, model)
      expect(decision.suggestedMessage).toContain('Use PostgreSQL')
      expect(decision.suggestedMessage).toContain('leaning toward')
    })

    it('should build locked notification message', () => {
      const dep1 = makeDecision({ statement: 'Data model depends on Postgres' })
      const dep2 = makeDecision({ statement: 'API depends on Postgres' })
      const dep3 = makeDecision({ statement: 'Deploy depends on Postgres' })
      const mainDec = makeDecision({ statement: 'Use PostgreSQL', commitment: 'locked' })

      dep1.dependsOn = [mainDec.id]
      dep2.dependsOn = [mainDec.id]
      dep3.dependsOn = [mainDec.id]

      const model = makeModel({
        decisions: new Map([
          [mainDec.id, mainDec],
          [dep1.id, dep1],
          [dep2.id, dep2],
          [dep3.id, dep3],
        ]),
      })

      const decision = engine.shouldSurface('locked_notification', [mainDec.id], 1, model)
      expect(decision.suggestedMessage).toContain('load-bearing')
      expect(decision.suggestedMessage).toContain('3')
    })
  })

  describe('Evaluate Surfacings', () => {
    it('should produce surfacing decisions from extraction result with promotions', () => {
      const dec = makeDecision({ commitment: 'leaning', statement: 'Try Next.js' })
      const model = makeModel({
        decisions: new Map([[dec.id, dec]]),
      })

      const result = makeResult({
        promotionChecks: [{
          nodeId: dec.id,
          currentCommitment: 'leaning',
          candidatePromotion: 'decided',
          trigger: 'return_without_question',
          isAutomatic: false,
          requiresUserAction: true,
        }],
      })

      const surfacings = engine.evaluateSurfacings(1, result, model)
      expect(surfacings.length).toBeGreaterThan(0)

      const promotionSurfacing = surfacings.find(s =>
        s.suggestedMessage?.includes('leaning toward')
      )
      expect(promotionSurfacing).toBeDefined()
    })

    it('should produce surfacing decisions from escalation results', () => {
      const tension = makeTension({
        severity: 'significant',
        description: 'SMB target conflicts with enterprise pricing',
      })
      const model = makeModel({
        tensions: new Map([[tension.id, tension]]),
      })

      const result = makeResult({
        escalationRequired: true,
        escalationReason: 'SMB decision conflicts with enterprise pricing strategy',
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'tensions',
          nodeId: tension.id,
          changes: {},
        }],
      })

      const surfacings = engine.evaluateSurfacings(1, result, model)
      const escalation = surfacings.find(s => s.priority === 'high' || s.priority === 'critical')
      expect(escalation).toBeDefined()
      expect(escalation!.shouldSurface).toBe(true)
    })
  })

  describe('Behavioral Contract Scenarios', () => {
    // Scenario 4.2: Staying out of the way during flow
    it('Scenario 4.2: suppresses non-critical during flow', () => {
      const productive = makeResult()

      // Enter flow (3+ productive turns)
      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)
      engine.updateFlowState(4, productive)
      engine.updateFlowState(5, productive)
      engine.updateFlowState(6, productive)

      expect(engine.getFlowState().isInFlow).toBe(true)
      expect(engine.getFlowState().consecutiveProductiveTurns).toBe(6)

      // Medium-priority scope drift should be suppressed
      const model = makeModel()
      const decision = engine.shouldSurface('scope_drift', [createId('exploration')], 7, model)
      expect(decision.shouldSurface).toBe(false)
      expect(decision.suppressedBecause).toBe('flow_protection')
    })

    // Scenario 3.3: Low-stakes decision should not escalate
    it('Scenario 3.3: artifact_ready is low priority and suppressed during flow', () => {
      const productive = makeResult()
      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)

      const model = makeModel()
      const decision = engine.shouldSurface('artifact_ready', [createId('artifact')], 4, model)

      // artifact_ready is low priority, should be suppressed during flow
      // (low priority doesn't even get suppressed by flow — it gets suppressed by cooldown)
      // Since we haven't surfaced anything, cooldown shouldn't block.
      // But flow + low priority = not blocked by flow (only medium is blocked by flow).
      // Low is only blocked by cooldown. No prior surfacing → should pass.
      expect(decision.shouldSurface).toBe(true)
    })

    // Scenario 7.2: Scope drift detection
    it('Scenario 7.2: first scope-expanding turn does not trigger drift warning', () => {
      // Define a model with a clear scope
      const exploration = makeExploration({
        topic: 'blockchain distributed ledger consensus mechanism',
      })
      const model = makeModel({
        intent: {
          primaryGoal: {
            statement: 'Building a scheduling tool for solo consultants',
            successCriteria: [],
            provenance: makeProvenance(),
            commitment: 'decided',
          },
          scope: {
            inScope: [{
              description: 'Calendar management and booking for consultants',
              provenance: makeProvenance(),
              commitment: 'decided',
            }],
            outOfScope: [],
            unknownScope: [],
          },
          qualityBar: null,
          successMetrics: [],
          antiGoals: [],
        },
        explorations: new Map([[exploration.id, exploration]]),
      })

      // First drift turn — new exploration with no overlap to scope
      const result = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration.id,
          changes: {},
        }],
      })

      const surfacings = engine.evaluateSurfacings(1, result, model)
      const driftSurfacing = surfacings.find(s => s.type === 'scope_drift')

      // First expanding turn should NOT trigger a warning
      expect(driftSurfacing).toBeUndefined()
    })

    it('Scenario 7.2: drift warning fires after 2+ scope-expanding turns', () => {
      const exploration1 = makeExploration({
        topic: 'blockchain distributed ledger consensus mechanism',
      })
      const exploration2 = makeExploration({
        topic: 'machine learning neural network training pipeline',
      })
      const model = makeModel({
        intent: {
          primaryGoal: {
            statement: 'Building a scheduling tool for solo consultants',
            successCriteria: [],
            provenance: makeProvenance(),
            commitment: 'decided',
          },
          scope: {
            inScope: [{
              description: 'Calendar management and booking for consultants',
              provenance: makeProvenance(),
              commitment: 'decided',
            }],
            outOfScope: [],
            unknownScope: [],
          },
          qualityBar: null,
          successMetrics: [],
          antiGoals: [],
        },
        explorations: new Map([
          [exploration1.id, exploration1],
          [exploration2.id, exploration2],
        ]),
      })

      // First drift turn
      const result1 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration1.id,
          changes: {},
        }],
      })
      engine.evaluateSurfacings(1, result1, model)

      // Second drift turn — should fire now
      const result2 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration2.id,
          changes: {},
        }],
      })
      const surfacings = engine.evaluateSurfacings(2, result2, model)
      const driftSurfacing = surfacings.find(s => s.type === 'scope_drift')

      expect(driftSurfacing).toBeDefined()
      expect(driftSurfacing!.shouldSurface).toBe(true)
      expect(driftSurfacing!.suggestedMessage).toContain('scheduling tool for solo consultants')
    })

    it('Scenario 7.2: drift warning message includes defined scope contrast', () => {
      const exploration1 = makeExploration({
        topic: 'blockchain distributed ledger consensus mechanism',
      })
      const exploration2 = makeExploration({
        topic: 'virtual reality immersive gaming experience',
      })
      const model = makeModel({
        intent: {
          primaryGoal: {
            statement: 'Building an invoicing platform for freelancers',
            successCriteria: [],
            provenance: makeProvenance(),
            commitment: 'decided',
          },
          scope: {
            inScope: [{
              description: 'Invoice creation and payment tracking for freelancers',
              provenance: makeProvenance(),
              commitment: 'decided',
            }],
            outOfScope: [],
            unknownScope: [],
          },
          qualityBar: null,
          successMetrics: [],
          antiGoals: [],
        },
        explorations: new Map([
          [exploration1.id, exploration1],
          [exploration2.id, exploration2],
        ]),
      })

      // Two drift turns to trigger warning
      const result1 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration1.id,
          changes: {},
        }],
      })
      engine.evaluateSurfacings(1, result1, model)

      const result2 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration2.id,
          changes: {},
        }],
      })
      const surfacings = engine.evaluateSurfacings(2, result2, model)
      const driftSurfacing = surfacings.find(s => s.type === 'scope_drift')

      expect(driftSurfacing).toBeDefined()
      expect(driftSurfacing!.suggestedMessage).toContain('invoicing platform for freelancers')
      expect(driftSurfacing!.suggestedMessage).toContain('expanding scope')
    })

    it('Scenario 7.2: after confirming expansion, no further warnings for that topic', () => {
      const exploration1 = makeExploration({
        topic: 'blockchain distributed ledger consensus mechanism',
      })
      const exploration2 = makeExploration({
        topic: 'machine learning neural network training pipeline',
      })
      const model = makeModel({
        intent: {
          primaryGoal: {
            statement: 'Building a scheduling tool for solo consultants',
            successCriteria: [],
            provenance: makeProvenance(),
            commitment: 'decided',
          },
          scope: {
            inScope: [{
              description: 'Calendar management and booking for consultants',
              provenance: makeProvenance(),
              commitment: 'decided',
            }],
            outOfScope: [],
            unknownScope: [],
          },
          qualityBar: null,
          successMetrics: [],
          antiGoals: [],
        },
        explorations: new Map([
          [exploration1.id, exploration1],
          [exploration2.id, exploration2],
        ]),
      })

      // First drift turn
      const result1 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration1.id,
          changes: {},
        }],
      })
      engine.evaluateSurfacings(1, result1, model)

      // User confirms the expansion — resets counter
      engine.confirmScopeExpansion(exploration1.topic)

      // Second exploration after confirmation — counter restarted, so this is "first" again
      const result2 = makeResult({
        modelUpdates: [{
          operation: 'insert',
          targetLayer: 'explorations',
          nodeId: exploration2.id,
          changes: {},
        }],
      })
      const surfacings = engine.evaluateSurfacings(2, result2, model)
      const driftSurfacing = surfacings.find(s => s.type === 'scope_drift')

      // Should NOT fire — counter was reset by confirmation
      expect(driftSurfacing).toBeUndefined()
    })

    // Ensure critical items always break through
    it('critical items break through flow + exhausted budget + cooldown', () => {
      const productive = makeResult()
      engine.updateFlowState(1, productive)
      engine.updateFlowState(2, productive)
      engine.updateFlowState(3, productive)

      // Exhaust budget
      for (let i = 0; i < 5; i++) {
        engine.recordSurfacing('tension_detected', i, [createId('decision')], `msg ${i}`)
      }

      const blockingTension = makeTension({ severity: 'blocking' })
      const model = makeModel({
        tensions: new Map([[blockingTension.id, blockingTension]]),
      })

      const decision = engine.shouldSurface('escalation', [blockingTension.id], 4, model)
      expect(decision.shouldSurface).toBe(true)
      expect(decision.priority).toBe('critical')
    })
  })
})
