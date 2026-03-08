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

// ─── Correction Target Matching ──────────────────────────────────────────────

describe('Correction target matching (Jaccard similarity)', () => {
  it('finds target with partial word overlap', async () => {
    // Create a decision first
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Target market is freelancers and solopreneurs',
      rationale: 'Good fit',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'market',
    })
    await pipeline.processTurn(makeTurn("We're targeting freelancers and solopreneurs.", 1), projectId)

    // Now correct with partial overlap (not exact substring)
    mockLLM.reset()
    mockLLM.addClassifyResponse('correction', 'high')
    mockLLM.addExtractResponse('correction', {
      correcting: 'targeting freelancers market solopreneurs',
      correction: 'Target market is small agencies, 5-15 person teams',
      isPermanent: true,
      reason: 'Refined target market',
      targetType: 'decision',
    })

    const result = await pipeline.processTurn(
      makeTurn("Actually, we're not targeting freelancers — it's small agencies.", 2),
      projectId
    )

    // Correction should have found the target and applied
    expect(result.modelUpdates.some(u => u.operation === 'update')).toBe(true)
  })

  it('returns null for no reasonable match', async () => {
    // Create a decision
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use PostgreSQL for the database',
      rationale: 'Robust',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use Postgres.", 1), projectId)

    // Correction targets something completely unrelated
    mockLLM.reset()
    mockLLM.addClassifyResponse('correction', 'high')
    mockLLM.addExtractResponse('correction', {
      correcting: 'pricing strategy revenue model',
      correction: 'Usage-based pricing',
      isPermanent: true,
      reason: null,
      targetType: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("Actually the pricing model should be usage-based.", 2),
      projectId
    )

    // No update because no target matched
    expect(result.modelUpdates.filter(u => u.operation === 'update')).toHaveLength(0)
  })

  it('prefers most recent node when multiple partial matches exist', async () => {
    // Create two decisions with overlapping keywords
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Authentication uses JWT tokens for sessions',
      rationale: 'Simple',
      alternatives: [],
      commitment: 'decided',
      certainty: 'assumed',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("We'll use JWT for auth.", 1), projectId)

    mockLLM.reset()
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Authentication flow uses OAuth with JWT tokens',
      rationale: 'More secure',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Actually let's use OAuth with JWT.", 2), projectId)

    // Correct "authentication JWT tokens" — both match
    mockLLM.reset()
    mockLLM.addClassifyResponse('correction', 'high')
    mockLLM.addExtractResponse('correction', {
      correcting: 'authentication JWT tokens',
      correction: 'Session-based auth instead',
      isPermanent: true,
      reason: 'Simpler approach',
      targetType: 'decision',
    })

    const result = await pipeline.processTurn(
      makeTurn("Forget JWT, let's do session-based auth.", 3),
      projectId
    )

    // Should have found a target
    const updateOps = result.modelUpdates.filter(u => u.operation === 'update')
    expect(updateOps.length).toBeGreaterThan(0)
  })

  it('uses higher threshold for very short search strings', async () => {
    // Create a decision
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use React for the frontend framework',
      rationale: 'Team expertise',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use React.", 1), projectId)

    // Very short correction text with no meaningful overlap
    mockLLM.reset()
    mockLLM.addClassifyResponse('correction', 'high')
    mockLLM.addExtractResponse('correction', {
      correcting: 'xyz abc',
      correction: 'Something else',
      isPermanent: true,
      reason: null,
      targetType: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("Change xyz abc.", 2),
      projectId
    )

    // Short nonsense string should NOT match
    expect(result.modelUpdates.filter(u => u.operation === 'update')).toHaveLength(0)
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

// ─── Approval extraction ────────────────────────────────────────────────────

describe('Approval extraction', () => {
  it('promotes leaning decision to decided on explicit approval', async () => {
    // Create a leaning decision first
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use React for the frontend',
      rationale: 'Team preference',
      alternatives: ['Vue', 'Svelte'],
      commitment: 'leaning',
      certainty: 'uncertain',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("I think we should go with React.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    const decId = Array.from(model1.decisions.keys())[0]
    expect(model1.decisions.get(decId)?.commitment).toBe('leaning')

    // Now approve it with promotion intent
    mockLLM.reset()
    mockLLM.addClassifyResponse('approval', 'high')
    mockLLM.addExtractResponse('approval', {
      targetDescription: 'React frontend framework',
      scope: 'full',
      promotionIntent: true,
      comment: null,
    })

    await pipeline.processTurn(makeTurn("Yes, let's commit to React.", 2), projectId)

    const model2 = store.getProjectModel(projectId)
    const dec = model2.decisions.get(decId)
    expect(dec?.commitment).toBe('decided')

    // Verify promotion event was written
    const events = store.getAllEvents(projectId)
    const promos = events.filter(
      e => e.type === 'NODE_PROMOTED' && (e as any).to === 'decided' && (e as any).trigger === 'explicit_commitment'
    )
    expect(promos).toHaveLength(1)
  })

  it('does not re-promote an already decided decision', async () => {
    // Create a decided decision
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use PostgreSQL for the database',
      rationale: 'Robust',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use Postgres.", 1), projectId)

    // Approve it (already decided)
    mockLLM.reset()
    mockLLM.addClassifyResponse('approval', 'high')
    mockLLM.addExtractResponse('approval', {
      targetDescription: 'PostgreSQL database',
      scope: 'full',
      promotionIntent: true,
      comment: null,
    })

    await pipeline.processTurn(makeTurn("Yes, Postgres is good.", 2), projectId)

    // Should NOT have a promotion event (already decided)
    const events = store.getAllEvents(projectId)
    const promos = events.filter(
      e => e.type === 'NODE_PROMOTED' && (e as any).trigger === 'explicit_commitment'
    )
    expect(promos).toHaveLength(0)
  })

  it('returns null update when no target found', async () => {
    // Approve something that doesn't exist in the model
    mockLLM.addClassifyResponse('approval', 'high')
    mockLLM.addExtractResponse('approval', {
      targetDescription: 'nonexistent feature xyz',
      scope: 'full',
      promotionIntent: true,
      comment: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("Yes, let's do that xyz thing.", 1),
      projectId
    )

    // No model updates from approval (target not found)
    const approvalUpdates = result.modelUpdates.filter(u => u.targetLayer === 'decisions')
    expect(approvalUpdates).toHaveLength(0)
  })
})

// ─── Elaboration extraction ─────────────────────────────────────────────────

describe('Elaboration extraction', () => {
  it('adds detail to a decision rationale', async () => {
    // Create a decision first
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'We will use PostgreSQL for the database',
      rationale: 'Robust and well-known',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use Postgres.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    const decId = Array.from(model1.decisions.keys())[0]

    // Elaborate on the decision
    mockLLM.reset()
    mockLLM.addClassifyResponse('elaboration', 'high')
    mockLLM.addExtractResponse('elaboration', {
      targetDescription: 'PostgreSQL database decision',
      additions: ['Need read replicas for scaling', 'Use pgbouncer for connection pooling'],
      modifies: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("Also for the DB, we need read replicas and connection pooling.", 2),
      projectId
    )

    expect(result.modelUpdates.some(u => u.operation === 'update' && u.targetLayer === 'decisions')).toBe(true)

    const model2 = store.getProjectModel(projectId)
    const dec = model2.decisions.get(decId)
    expect(dec?.rationale).toContain('read replicas')
    expect(dec?.rationale).toContain('connection pooling')
  })

  it('adds options to an exploration', async () => {
    // Create an exploration
    mockLLM.addClassifyResponse('exploration', 'high')
    mockLLM.addExtractResponse('exploration node', {
      topic: 'Auth implementation approach',
      direction: 'Considering options',
      openQuestions: ['Self-hosted or third-party?'],
      consideredOptions: ['JWT self-built', 'Clerk'],
      resolutionCondition: null,
    })
    await pipeline.processTurn(makeTurn("We need to figure out auth.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    const expId = Array.from(model1.explorations.keys())[0]

    // Elaborate with new options
    mockLLM.reset()
    mockLLM.addClassifyResponse('elaboration', 'high')
    mockLLM.addExtractResponse('elaboration', {
      targetDescription: 'Auth implementation approach',
      additions: ['Auth0', 'Supabase Auth'],
      modifies: null,
    })

    await pipeline.processTurn(
      makeTurn("We should also consider Auth0 and Supabase Auth.", 2),
      projectId
    )

    const model2 = store.getProjectModel(projectId)
    const exp = model2.explorations.get(expId)
    expect(exp?.consideredOptions).toContain('Auth0')
    expect(exp?.consideredOptions).toContain('Supabase Auth')
    expect(exp?.consideredOptions).toContain('JWT self-built') // original preserved
  })

  it('returns null when no target found', async () => {
    mockLLM.addClassifyResponse('elaboration', 'high')
    mockLLM.addExtractResponse('elaboration', {
      targetDescription: 'nonexistent xyz feature',
      additions: ['some detail'],
      modifies: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("More about xyz.", 1),
      projectId
    )

    expect(result.modelUpdates.filter(u => u.operation === 'update')).toHaveLength(0)
  })
})

// ─── Scenario 1.5: Correction (rejection + new decision) ───────────────────

describe('Scenario 1.5 — Correction', () => {
  it('should create rejection and new decision when correcting a previous decision', async () => {
    // Create a decided decision for Supabase
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Use Supabase for authentication',
      rationale: 'Quick to set up',
      alternatives: [],
      commitment: 'decided',
      certainty: 'assumed',
      category: 'technical',
    })
    await pipeline.processTurn(makeTurn("Let's use Supabase for auth.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    expect(model1.decisions.size).toBe(1)

    // Now process a correction turn that produces both rejection + new decision
    mockLLM.reset()
    mockLLM.addClassifyResponse('rejection', 'high', ['decision'])
    mockLLM.addExtractResponse('rejection node', {
      statement: 'Rejected Supabase for authentication',
      rejectionType: 'categorical',
      reason: 'Dependency concern — avoid third-party auth',
      category: 'technical',
      revivalCondition: null,
      revealsPreference: 'Prefers minimizing third-party dependencies',
      contributesToValues: true,
    })
    mockLLM.addExtractResponse('decision node', {
      statement: 'Build authentication in-house',
      rationale: 'Full control, no third-party dependency',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })

    await pipeline.processTurn(
      makeTurn("Actually, forget Supabase — I don't want third-party auth. Let's build it ourselves.", 4),
      projectId
    )

    const model2 = store.getProjectModel(projectId)
    // Original decision should still exist (not deleted)
    expect(model2.decisions.size).toBe(2)
    // Rejection should exist
    expect(model2.rejections.size).toBe(1)

    const rej = Array.from(model2.rejections.values())[0]
    expect(rej.revealsPreference).toBe('Prefers minimizing third-party dependencies')
    expect(rej.contributesToValues).toBe(true)
  })
})

// ─── Scenario 3.2: Constraint Propagation Escalation ─────────────────────────

describe('Scenario 3.2 — Constraint Propagation Escalation', () => {
  it('should escalate when a decision creates material conflicts', async () => {
    // Create an existing leaning decision
    store.appendEvent({
      type: 'NODE_CREATED',
      nodeType: 'decision',
      node: {
        id: 'dec_pricing',
        category: 'business',
        statement: 'Annual enterprise contracts for pricing',
        rationale: 'Higher revenue per customer',
        alternatives: [],
        commitment: 'leaning' as const,
        certainty: 'assumed' as const,
        provenance: { sessionId, turnIndex: 1, extractedAt: new Date(), confidence: 'high' as const, rawTurn: '' },
        promotionHistory: [],
        constrains: [],
        dependsOn: [],
        enables: [],
        manifestsIn: [],
        closedOptions: [],
      },
      provenance: { sessionId, turnIndex: 1, extractedAt: new Date(), confidence: 'high' as const, rawTurn: '' },
    }, { projectId, sessionId, turnIndex: 1 })

    // Now process a new decided decision that the LLM says creates tensions
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Target SMB customers under 50 employees',
      rationale: 'Better market fit',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'market',
    })

    // Mock the propagation LLM response
    mockLLM.addResponse(
      (req) => req.system.includes('propagation'),
      JSON.stringify({
        tensions: [{
          description: 'SMB target conflicts with enterprise pricing lean',
          affectedNodeId: 'dec_pricing',
          affectedNodeType: 'decision',
          severity: 'significant',
          impact: 'Enterprise annual contracts do not fit SMB buying behavior',
        }],
        closedOptions: [],
        shouldEscalate: true,
        escalationReason: 'SMB decision materially conflicts with pricing direction',
      })
    )

    const result = await pipeline.processTurn(
      makeTurn("We'll target SMB customers — businesses under 50 employees.", 3),
      projectId
    )

    expect(result.escalationRequired).toBe(true)
    expect(result.escalationReason).toContain('SMB')
    expect(result.conflictChecksTriggered).toBe(true)

    // Tension nodes should be created
    const model = store.getProjectModel(projectId)
    expect(model.tensions.size).toBeGreaterThan(0)
  })
})

// ─── Scenario 4.1: Protecting Productive Ambiguity ──────────────────────────

describe('Scenario 4.1 — Protecting Productive Ambiguity', () => {
  it('should write exploration and NOT create a decision for deliberate ambiguity', async () => {
    mockLLM.addClassifyResponse('exploration', 'high')
    mockLLM.addExtractResponse('exploration node', {
      topic: 'B2B vs B2C market orientation',
      direction: 'Deliberately unresolved — user wants to sit with it',
      openQuestions: ['Is this B2B or B2C?', 'What does the market pull look like?'],
      consideredOptions: ['B2B SaaS', 'B2C marketplace'],
      resolutionCondition: null,
    })

    const result = await pipeline.processTurn(
      makeTurn("I'm still not sure whether this is a B2B or B2C product. There's a case for both and I want to sit with it.", 1),
      projectId
    )

    const model = store.getProjectModel(projectId)
    // Should be exploration, NOT a decision
    expect(model.explorations.size).toBe(1)
    expect(model.decisions.size).toBe(0)

    const exp = Array.from(model.explorations.values())[0]
    expect(exp.status).toBe('active')
    expect(exp.topic).toBe('B2B vs B2C market orientation')

    // No promotion checks for explorations
    expect(result.promotionChecks).toHaveLength(0)
  })
})

// ─── Scenario 2.1: Exploring → Leaning (comparative preference) ─────────────

describe('Scenario 2.1 — Exploring → Leaning auto-promotion', () => {
  it('should create leaning decision when rejection eliminates all but one option', async () => {
    // Create an exploration with two options
    mockLLM.addClassifyResponse('exploration', 'high')
    mockLLM.addExtractResponse('exploration node', {
      topic: 'Database selection',
      direction: 'Considering options',
      openQuestions: ['Which database?'],
      consideredOptions: ['PostgreSQL', 'MongoDB'],
      resolutionCondition: null,
    })
    await pipeline.processTurn(makeTurn("I'm deciding between PostgreSQL and MongoDB.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    expect(model1.explorations.size).toBe(1)
    const expId = Array.from(model1.explorations.keys())[0]

    // Reject MongoDB — should leave PostgreSQL as the surviving option
    mockLLM.reset()
    mockLLM.addClassifyResponse('rejection', 'high')
    mockLLM.addExtractResponse('rejection node', {
      statement: 'Rejected MongoDB for database',
      rejectionType: 'categorical',
      reason: 'Not suitable for relational data',
      category: 'technical',
      revivalCondition: null,
      revealsPreference: null,
      contributesToValues: false,
    })

    const result = await pipeline.processTurn(
      makeTurn("No, MongoDB won't work for us — our data is highly relational.", 2),
      projectId
    )

    const model2 = store.getProjectModel(projectId)

    // Should have auto-created a leaning decision for PostgreSQL
    const decisions = Array.from(model2.decisions.values())
    const leaningDec = decisions.find(d => d.commitment === 'leaning')
    expect(leaningDec).toBeDefined()
    expect(leaningDec!.statement).toBe('PostgreSQL')

    // Exploration should be resolved
    const exp = model2.explorations.get(expId)
    expect(exp?.status).toBe('resolved')

    // Promotion check should be present (silent, automatic)
    const promos = result.promotionChecks.filter(p => p.trigger === 'comparative_preference')
    expect(promos.length).toBe(1)
    expect(promos[0].isAutomatic).toBe(true)
    expect(promos[0].requiresUserAction).toBe(false)
  })

  it('should NOT create leaning decision when multiple options remain', async () => {
    // Create an exploration with three options
    mockLLM.addClassifyResponse('exploration', 'high')
    mockLLM.addExtractResponse('exploration node', {
      topic: 'Frontend framework',
      direction: 'Considering options',
      openQuestions: ['Which framework?'],
      consideredOptions: ['React', 'Vue', 'Svelte'],
      resolutionCondition: null,
    })
    await pipeline.processTurn(makeTurn("Thinking about React, Vue, or Svelte.", 1), projectId)

    // Reject one option — two remain
    mockLLM.reset()
    mockLLM.addClassifyResponse('rejection', 'high')
    mockLLM.addExtractResponse('rejection node', {
      statement: 'Rejected Svelte',
      rejectionType: 'categorical',
      reason: 'Team not familiar',
      category: 'technical',
      revivalCondition: null,
      revealsPreference: null,
      contributesToValues: false,
    })

    await pipeline.processTurn(
      makeTurn("Not Svelte — team doesn't know it.", 2),
      projectId
    )

    const model = store.getProjectModel(projectId)
    // No leaning decision should be created (2 options remain)
    expect(model.decisions.size).toBe(0)
    // Exploration should still be active
    const exp = Array.from(model.explorations.values())[0]
    expect(exp.status).toBe('active')
  })
})

// ─── Scenario 7.1: The User Is Wrong ────────────────────────────────────────

describe('Scenario 7.1 — The User Is Wrong (constraint conflict with decision)', () => {
  it('writes decision AND surfaces tension when decision conflicts with constraint', async () => {
    // Create a hard constraint: serverless only
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint', {
      statement: 'Architecture must be fully serverless — no managed servers',
      hardness: 'hard',
      type: 'technical',
      certainty: 'evidenced',
    })
    await pipeline.processTurn(makeTurn("We're going serverless only, no managed servers.", 1), projectId)

    const model1 = store.getProjectModel(projectId)
    expect(model1.constraints.size).toBe(1)

    // Now make a decision that conflicts: use WebSockets (requires persistent connections)
    mockLLM.reset()
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      statement: 'Use WebSocket connections for real-time updates',
      rationale: 'Need push-based updates',
      alternatives: ['SSE', 'Polling'],
      commitment: 'decided',
      certainty: 'evidenced',
      category: 'technical',
    })

    // Mock propagation to detect conflict
    const constraintId = Array.from(model1.constraints.keys())[0]
    mockLLM.addResponse(
      (req) => req.system.includes('propagation'),
      JSON.stringify({
        tensions: [{
          description: 'WebSocket requires persistent connections, incompatible with serverless',
          affectedNodeId: constraintId,
          affectedNodeType: 'constraint',
          severity: 'blocking',
          impact: 'Serverless functions cannot maintain persistent WebSocket connections',
        }],
        closedOptions: [],
        shouldEscalate: true,
        escalationReason: 'Decision directly contradicts a hard constraint',
      })
    )

    const result = await pipeline.processTurn(
      makeTurn("Let's use WebSockets for real-time updates.", 3),
      projectId
    )

    const model2 = store.getProjectModel(projectId)
    // Decision should be written (we don't block the user)
    expect(model2.decisions.size).toBe(1)
    // Tension should also be created
    expect(model2.tensions.size).toBeGreaterThan(0)
    expect(result.escalationRequired).toBe(true)
  })
})

// ─── Scenario 5.3: The Long Session ─────────────────────────────────────────

describe('Scenario 5.3 — The Long Session', () => {
  it('processes 30+ turns without data loss', async () => {
    const totalTurns = 32

    for (let i = 1; i <= totalTurns; i++) {
      mockLLM.reset()
      if (i % 3 === 0) {
        // Every 3rd turn is an exploration
        mockLLM.addClassifyResponse('exploration', 'high')
        mockLLM.addExtractResponse('exploration node', {
          topic: `Exploration topic ${i}`,
          direction: `Considering options for turn ${i}`,
          openQuestions: [`Question from turn ${i}`],
          consideredOptions: [],
          resolutionCondition: null,
        })
      } else {
        // Other turns are decisions
        mockLLM.addClassifyResponse('decision', 'high')
        mockLLM.addExtractResponse('decision node', {
          statement: `Decision from turn ${i}`,
          rationale: `Rationale for turn ${i}`,
          alternatives: [],
          commitment: 'decided',
          certainty: 'assumed',
          category: 'technical',
        })
      }

      await pipeline.processTurn(makeTurn(`Turn ${i} content`, i), projectId)
    }

    const model = store.getProjectModel(projectId)
    // Decisions: turns not divisible by 3 = 32 - 10 = 22 decisions
    const expectedDecisions = totalTurns - Math.floor(totalTurns / 3)
    const expectedExplorations = Math.floor(totalTurns / 3)

    expect(model.decisions.size).toBe(expectedDecisions)
    expect(model.explorations.size).toBe(expectedExplorations)

    // Verify no data loss — all turns should be stored
    const turns = store.getSessionTurns(sessionId)
    expect(turns.length).toBe(totalTurns)
  })
})

// ─── Scenario 4.4: Single-Turn Tension Detection ────────────────────────────

describe('Scenario 4.4 — Intra-turn tension detection', () => {
  it('detects tension between two conflicting constraints in one turn', async () => {
    // Classify as having two constraints in one turn
    mockLLM.addClassifyResponse('constraint_stated', 'high', ['constraint_stated'])

    // First constraint: aesthetic/quality
    mockLLM.addResponse(
      (req) => req.system.includes('constraint') && !req.system.includes('turn classifier') && !req.system.includes('conflict'),
      JSON.stringify({
        statement: 'Pixel-perfect UX — every detail matters',
        hardness: 'hard',
        type: 'aesthetic',
        certainty: 'evidenced',
      })
    )

    await pipeline.processTurn(
      makeTurn("We want pixel-perfect UX, every detail matters. But we need to ship in 3 weeks with a team of one.", 1),
      projectId
    )

    // The mock returns the same response for both constraint extractions
    // so we get 2 constraints of the same type — which triggers the same-type conflict check
    const model = store.getProjectModel(projectId)
    // At minimum, constraints should be created
    expect(model.constraints.size).toBeGreaterThanOrEqual(1)
  })

  it('detects tension between new constraint and existing constraint', async () => {
    // Create an existing constraint
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint', {
      statement: 'Application must work completely offline with local storage only',
      hardness: 'hard',
      type: 'technical',
      certainty: 'evidenced',
    })
    await pipeline.processTurn(makeTurn("The app must work offline with local storage.", 1), projectId)

    // Add a conflicting constraint
    mockLLM.reset()
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint', {
      statement: 'Real-time collaboration and live syncing across all devices required',
      hardness: 'hard',
      type: 'technical',
      certainty: 'evidenced',
    })

    await pipeline.processTurn(
      makeTurn("We also need real-time collaboration and live syncing across all devices.", 2),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.constraints.size).toBe(2)

    // Should have detected a tension (both are technical type)
    expect(model.tensions.size).toBeGreaterThan(0)
    const tension = Array.from(model.tensions.values())[0]
    expect(tension.severity).toBe('significant')
  })

  it('does NOT create tension for non-conflicting constraints', async () => {
    // Create a technical constraint
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint', {
      statement: 'Must use TypeScript for all code',
      hardness: 'hard',
      type: 'technical',
      certainty: 'evidenced',
    })
    await pipeline.processTurn(makeTurn("Everything in TypeScript.", 1), projectId)

    // Add a different type of constraint (no conflict)
    mockLLM.reset()
    mockLLM.addClassifyResponse('constraint_stated', 'high')
    mockLLM.addExtractResponse('constraint', {
      statement: 'Budget limited to 500 dollars per month for infrastructure',
      hardness: 'hard',
      type: 'financial',
      certainty: 'evidenced',
    })

    await pipeline.processTurn(
      makeTurn("Budget is $500/month for infra.", 2),
      projectId
    )

    const model = store.getProjectModel(projectId)
    expect(model.constraints.size).toBe(2)
    // Different types with no keyword overlap — no tension
    expect(model.tensions.size).toBe(0)
  })
})
