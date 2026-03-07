import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ExtractionPipeline } from '../pipeline'
import { ProjectModelStore } from '@gzoo/forge-store'
import { MockLLMClient } from './mock-llm'
import type { ConversationalTurn } from '@gzoo/forge-core'

let store: ProjectModelStore
let mockLLM: MockLLMClient
let pipeline: ExtractionPipeline
let projectId: string
let sessionId: string

function makeTurn(text: string, turnIndex: number): ConversationalTurn {
  return {
    sessionId,
    turnIndex,
    speaker: 'user',
    text,
    timestamp: new Date(),
  }
}

beforeEach(() => {
  store = new ProjectModelStore(':memory:')
  mockLLM = new MockLLMClient()
  pipeline = new ExtractionPipeline(store, mockLLM)
  projectId = store.createProject('ws_test', 'Test Project')
  sessionId = store.startSession(projectId)
})

afterEach(() => {
  store.close()
})

// ─── Scenario 1.1: Thinking Out Loud ─────────────────────────────────────────

describe('Scenario 1.1 — Thinking Out Loud', () => {
  it('should classify as exploration, not decision', async () => {
    mockLLM.addClassifyResponse('exploration', 'high')
    mockLLM.addExtractResponse('exploration node', {
      topic: 'Database selection',
      direction: 'Considering Postgres vs SQLite',
      openQuestions: ['Which database fits a local-first approach?'],
      consideredOptions: ['PostgreSQL', 'SQLite'],
      resolutionCondition: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("I'm thinking maybe we use Postgres for the database. Or maybe SQLite since this is local-first. I don't know, what do you think?", 1),
      projectId
    )

    expect(result.classifications[0].type).toBe('exploration')

    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(0)
    expect(model.explorations.size).toBe(1)

    const exploration = Array.from(model.explorations.values())[0]
    expect(exploration.topic).toBe('Database selection')
  })
})

// ─── Scenario 1.2: Implicit Commitment ───────────────────────────────────────

describe('Scenario 1.2 — Implicit Commitment', () => {
  it('should classify "Let\'s use X" as decided', async () => {
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use PostgreSQL for the database',
      rationale: 'Not stated',
      alternatives: [],
      commitment: 'decided',
      certainty: 'assumed',
      category: 'technical',
    })

    const result = await pipeline.processTurn(
      makeTurn("Let's use Postgres.", 4),
      projectId
    )

    expect(result.classifications[0].type).toBe('decision')

    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(1)
    const dec = Array.from(model.decisions.values())[0]
    expect(dec.commitment).toBe('decided')
    expect(dec.statement).toBe('We will use PostgreSQL for the database')
  })
})

// ─── Scenario 1.3: The Softened Decision ─────────────────────────────────────

describe('Scenario 1.3 — The Softened Decision', () => {
  it('should classify hedged language as leaning, not decided', async () => {
    mockLLM.addClassifyResponse('decision', 'medium')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use Next.js for the frontend',
      rationale: 'Not stated',
      alternatives: [],
      commitment: 'leaning',
      certainty: 'uncertain',
      category: 'technical',
    })

    const result = await pipeline.processTurn(
      makeTurn("I think we should probably go with Next.js for the frontend.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    const dec = Array.from(model.decisions.values())[0]
    expect(dec.commitment).toBe('leaning')
  })
})

// ─── Scenario 1.4: The False Decision (mixed turn) ──────────────────────────

describe('Scenario 1.4 — The False Decision', () => {
  it('should extract both a decision and an exploration from one turn', async () => {
    mockLLM.addClassifyResponse('decision', 'high', ['exploration'])
    mockLLM.addExtractResponse('decision node', {
      statement: 'Authentication is required',
      rationale: 'Explicitly stated as needed',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'product',
    })
    mockLLM.addExtractResponse('exploration node', {
      topic: 'Auth implementation approach',
      direction: 'Considering JWT self-built vs Clerk',
      openQuestions: ['Build auth in-house or use Clerk?'],
      consideredOptions: ['JWT self-built', 'Clerk'],
      resolutionCondition: null,
    })

    await pipeline.processTurn(
      makeTurn("We definitely need authentication. JWT is probably the right call, but I want to think about whether we do it ourselves or use something like Clerk.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(1)
    expect(model.explorations.size).toBe(1)

    const dec = Array.from(model.decisions.values())[0]
    expect(dec.statement).toBe('Authentication is required')
    expect(dec.commitment).toBe('decided')

    const exp = Array.from(model.explorations.values())[0]
    expect(exp.topic).toBe('Auth implementation approach')
  })
})

// ─── Scenario 2.2: The Locked Gate ───────────────────────────────────────────

describe('Scenario 2.2 — The Locked Gate (Cardinal Rule)', () => {
  it('should NEVER auto-promote leaning to decided', async () => {
    // Create a leaning decision first
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use usage-based pricing',
      rationale: 'Feels right for this product',
      alternatives: ['flat rate'],
      commitment: 'leaning',
      certainty: 'uncertain',
      category: 'business',
    })

    await pipeline.processTurn(makeTurn("I keep coming back to usage-based pricing.", 1), projectId)

    // Now process multiple supporting turns
    for (let i = 2; i <= 5; i++) {
      mockLLM.reset()
      mockLLM.addClassifyResponse('elaboration', 'high')

      await pipeline.processTurn(
        makeTurn(`More thoughts on usage-based pricing, turn ${i}`, i),
        projectId
      )
    }

    const model = store.getProjectModel(projectId)
    const dec = Array.from(model.decisions.values())[0]

    // THE CARDINAL RULE: commitment must still be 'leaning', NOT 'decided'
    expect(dec.commitment).toBe('leaning')

    // Verify no auto-promotion events were written
    const events = store.getAllEvents(projectId)
    const autoPromotions = events.filter(
      e => e.type === 'NODE_PROMOTED' && (e as any).to === 'decided' && (e as any).wasAutomatic === true
    )
    expect(autoPromotions).toHaveLength(0)
  })
})

// ─── Scenario 2.3: decided → locked ─────────────────────────────────────────

describe('Scenario 2.3 — Automatic decided → locked', () => {
  it('should auto-promote to locked when 3+ dependents exist', async () => {
    // Create a decided decision (the parent)
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use PostgreSQL',
      rationale: 'Robust',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use Postgres.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    const parentId = Array.from(model1.decisions.keys())[0]

    // Create 3 dependent decisions manually via store
    for (let i = 0; i < 3; i++) {
      const depId = `dec_dep${i}`
      store.appendEvent({
        type: 'NODE_CREATED',
        nodeType: 'decision',
        node: {
          id: depId,
          category: 'technical',
          statement: `Dependent decision ${i}`,
          rationale: '',
          alternatives: [],
          commitment: 'decided' as const,
          certainty: 'assumed' as const,
          provenance: { sessionId, turnIndex: i + 2, extractedAt: new Date(), confidence: 'high' as const, rawTurn: '' },
          promotionHistory: [],
          constrains: [],
          dependsOn: [parentId],
          enables: [],
          manifestsIn: [],
          closedOptions: [],
        },
        provenance: { sessionId, turnIndex: i + 2, extractedAt: new Date(), confidence: 'high' as const, rawTurn: '' },
      }, { projectId, sessionId, turnIndex: i + 2 })
    }

    // Process one more turn to trigger promotion check
    mockLLM.reset()
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Add connection pooling',
      rationale: 'Performance',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })

    const result = await pipeline.processTurn(
      makeTurn("Let's add connection pooling.", 6),
      projectId
    )

    // Check that a promotion to locked was triggered
    const events = store.getAllEvents(projectId)
    const lockPromotions = events.filter(
      e => e.type === 'NODE_PROMOTED' && (e as any).to === 'locked'
    )
    expect(lockPromotions.length).toBeGreaterThanOrEqual(1)

    const model = store.getProjectModel(projectId)
    const parent = model.decisions.get(parentId)
    expect(parent?.commitment).toBe('locked')
  })
})

// ─── No-op turns ─────────────────────────────────────────────────────────────

describe('No-op turns', () => {
  it('should not write nodes for question turns', async () => {
    mockLLM.addClassifyResponse('question', 'high')

    const result = await pipeline.processTurn(
      makeTurn("What database should we use?", 1),
      projectId
    )

    expect(result.modelUpdates).toHaveLength(0)

    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(0)
    expect(model.explorations.size).toBe(0)
  })

  it('should not write nodes for meta turns', async () => {
    mockLLM.addClassifyResponse('meta', 'high')

    const result = await pipeline.processTurn(
      makeTurn("Can we go back to what we discussed earlier?", 1),
      projectId
    )

    expect(result.modelUpdates).toHaveLength(0)
  })
})

// ─── Goal statement ──────────────────────────────────────────────────────────

describe('Goal statement extraction', () => {
  it('should update intent layer with goal', async () => {
    mockLLM.addClassifyResponse('goal_statement', 'high')
    mockLLM.addExtractResponse('project goal', {
      statement: 'Build a dispatch SaaS for HVAC companies',
      successCriteria: ['10 paying customers in 6 months'],
      commitment: 'decided',
    })

    await pipeline.processTurn(
      makeTurn("We're building a dispatch SaaS for HVAC companies.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.intent.primaryGoal?.statement).toBe('Build a dispatch SaaS for HVAC companies')
  })
})

// ─── Constraint extraction ───────────────────────────────────────────────────

describe('Constraint extraction', () => {
  it('should create a constraint node', async () => {
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint node', {
      statement: 'Must launch within 6 weeks',
      hardness: 'hard',
      type: 'timeline',
      certainty: 'evidenced',
    })

    await pipeline.processTurn(
      makeTurn("We have to launch this in 6 weeks, no exceptions.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.constraints.size).toBe(1)
    const con = Array.from(model.constraints.values())[0]
    expect(con.statement).toBe('Must launch within 6 weeks')
    expect(con.hardness).toBe('hard')
    expect(con.source).toBe('stated')
  })
})

// ─── Rejection extraction ────────────────────────────────────────────────────

describe('Rejection extraction', () => {
  it('should create a rejection node with values signal', async () => {
    mockLLM.addClassifyResponse('rejection', 'high')
    mockLLM.addExtractResponse('rejection node', {
      statement: 'We will NOT use Supabase for auth',
      rejectionType: 'categorical',
      reason: 'Dependency concern — prefers avoiding third-party auth services',
      category: 'technical',
      revivalCondition: null,
      revealsPreference: 'Prefers minimizing third-party service dependencies',
      contributesToValues: true,
    })

    await pipeline.processTurn(
      makeTurn("Actually, ignore what I said about Supabase — I don't want to be dependent on another third party.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.rejections.size).toBe(1)
    const rej = Array.from(model.rejections.values())[0]
    expect(rej.rejectionType).toBe('categorical')
    expect(rej.contributesToValues).toBe(true)
    expect(rej.revealsPreference).toBe('Prefers minimizing third-party service dependencies')
  })
})
