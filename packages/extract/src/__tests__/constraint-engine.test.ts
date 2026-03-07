import { describe, it, expect } from 'vitest'
import {
  computeConstraintScore,
  detectConstraintConflicts,
} from '../constraint-engine'
import {
  createId,
  createProvenance,
  type ProjectModel,
  type Constraint,
  type Decision,
} from '@gzoo/forge-core'

function createEmptyModel(): ProjectModel {
  return {
    id: createId('project'),
    workspaceId: 'ws_test',
    name: 'Test Project',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    sessionIds: [],
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
  }
}

function createTestConstraint(overrides: Partial<Constraint> = {}): Constraint {
  const prov = createProvenance('sess_test', 1, 'test', 'high')
  return {
    id: createId('constraint'),
    type: 'technical',
    statement: 'Must use Node.js',
    source: 'stated',
    hardness: 'hard',
    certainty: 'evidenced',
    provenance: prov,
    originStatementTurn: 1,
    propagatesTo: [],
    isRevealed: false,
    scope: 'project',
    ...overrides,
  }
}

function createTestDecision(overrides: Partial<Decision> = {}): Decision {
  const prov = createProvenance('sess_test', 1, 'test', 'high')
  return {
    id: createId('decision'),
    category: 'technical',
    statement: 'Use PostgreSQL',
    rationale: 'Best for our needs',
    alternatives: [],
    commitment: 'decided',
    certainty: 'evidenced',
    provenance: prov,
    promotionHistory: [],
    constrains: [],
    dependsOn: [],
    enables: [],
    manifestsIn: [],
    closedOptions: [],
    ...overrides,
  }
}

describe('Constraint Scoring', () => {
  it('scores a stated constraint with low frequency', () => {
    const model = createEmptyModel()
    const constraint = createTestConstraint({ isRevealed: false })

    const score = computeConstraintScore(constraint, model, 5, 10)

    // Stated constraints get frequency=15 (single instance)
    expect(score.frequency).toBe(15)
    expect(score.total).toBeGreaterThan(0)
    expect(score.total).toBeLessThanOrEqual(100)
  })

  it('scores a revealed constraint with higher frequency', () => {
    const model = createEmptyModel()
    const constraint = createTestConstraint({
      isRevealed: true,
      revealedEvidence: [
        'Chose simple option over complex',
        'Rejected enterprise feature',
        'Preferred solo-maintainable',
        'Said "I don\'t want to manage infrastructure"',
      ],
    })

    const score = computeConstraintScore(constraint, model, 15, 20)

    // 4 evidence instances * 25 = 100 (capped)
    expect(score.frequency).toBe(100)
    expect(score.total).toBeGreaterThan(50)
  })

  it('reduces consistency when contradictions exist', () => {
    const model = createEmptyModel()
    const constraint = createTestConstraint({
      statement: 'Must not use external services',
    })
    // Add a contradictory decision
    const dec = createTestDecision({
      statement: 'We will use external auth service Clerk',
    })
    model.decisions.set(dec.id, dec)

    const score = computeConstraintScore(constraint, model, 5, 10)

    // Should have reduced consistency due to contradiction
    expect(score.consistency).toBeLessThan(80)
  })

  it('applies correct weights', () => {
    const model = createEmptyModel()
    const constraint = createTestConstraint()

    const score = computeConstraintScore(constraint, model, 5, 10)

    // Verify the total is a weighted sum
    const expected = Math.round(
      score.recency * 0.25 +
      score.frequency * 0.35 +
      score.consistency * 0.25 +
      score.stakes * 0.15
    )
    expect(score.total).toBe(expected)
  })
})

describe('Constraint Conflict Detection', () => {
  it('detects conflict between stated and revealed constraints of the same type', () => {
    const model = createEmptyModel()

    const stated = createTestConstraint({
      statement: 'Must be enterprise-grade, built for scale',
      type: 'operational',
      isRevealed: false,
      source: 'stated',
    })
    const revealed = createTestConstraint({
      statement: 'Prefers simplicity and solo-maintainable systems',
      type: 'operational',
      isRevealed: true,
      source: 'revealed',
      revealedEvidence: [
        'Chose simple option',
        'Rejected complex architecture',
        'Said "I don\'t want to manage infrastructure"',
      ],
    })

    model.constraints.set(stated.id, stated)
    model.constraints.set(revealed.id, revealed)

    const conflicts = detectConstraintConflicts(model, 15, 20)

    expect(conflicts.length).toBe(1)
    expect(conflicts[0].statedConstraintId).toBe(stated.id)
    expect(conflicts[0].revealedConstraintId).toBe(revealed.id)
  })

  it('marks conflicts as unresolved when scores are close (delta < 15)', () => {
    const model = createEmptyModel()

    // Create constraints that will have similar scores
    const stated = createTestConstraint({
      statement: 'Must support multi-tenancy',
      type: 'technical',
      isRevealed: false,
      source: 'stated',
      originStatementTurn: 8, // Recent
    })
    const revealed = createTestConstraint({
      statement: 'Should use single-tenant architecture',
      type: 'technical',
      isRevealed: true,
      source: 'revealed',
      revealedEvidence: ['Discussed simple deployment'],
    })

    model.constraints.set(stated.id, stated)
    model.constraints.set(revealed.id, revealed)

    const conflicts = detectConstraintConflicts(model, 10, 10)

    expect(conflicts.length).toBe(1)
    // With close scores, should be unresolved
    const conflict = conflicts[0]
    expect(['unresolved', 'stated', 'revealed']).toContain(conflict.winner)
  })

  it('does not detect conflicts when no revealed constraints exist', () => {
    const model = createEmptyModel()

    const stated1 = createTestConstraint({ statement: 'Must use Node.js', type: 'technical' })
    const stated2 = createTestConstraint({ statement: 'Must use TypeScript', type: 'technical' })

    model.constraints.set(stated1.id, stated1)
    model.constraints.set(stated2.id, stated2)

    const conflicts = detectConstraintConflicts(model, 5, 10)
    expect(conflicts.length).toBe(0)
  })

  it('skips constraints that already have a conflict ID', () => {
    const model = createEmptyModel()

    const stated = createTestConstraint({
      type: 'technical',
      isRevealed: false,
      conflictId: createId('tension'), // Already has a conflict
    })
    const revealed = createTestConstraint({
      type: 'technical',
      isRevealed: true,
      source: 'revealed',
    })

    model.constraints.set(stated.id, stated)
    model.constraints.set(revealed.id, revealed)

    const conflicts = detectConstraintConflicts(model, 5, 10)
    expect(conflicts.length).toBe(0)
  })
})

describe('Scenario 3.3 — Low-Stakes Decision (No Escalation)', () => {
  it('should not trigger propagation for brand/aesthetic decisions', async () => {
    // This tests the isLowStakes check — brand decisions with assumed certainty
    // should not trigger the LLM propagation check
    const { checkPropagation } = await import('../constraint-engine')

    const decision = createTestDecision({
      category: 'brand',
      statement: 'The primary button color will be blue',
      certainty: 'assumed',
      rationale: '',
      alternatives: [],
    })

    const model = createEmptyModel()

    // Use a mock that would fail if called
    const mockLLM = {
      complete: async () => {
        throw new Error('Should not be called for low-stakes decisions')
      },
    }

    const result = await checkPropagation(decision, model, mockLLM)

    expect(result.tensions).toHaveLength(0)
    expect(result.closedOptions).toHaveLength(0)
    expect(result.shouldEscalate).toBe(false)
  })
})
