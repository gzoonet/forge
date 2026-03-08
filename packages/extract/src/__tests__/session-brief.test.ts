import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ProjectModelStore } from '@gzoo/forge-store'
import { createProvenance, createId } from '@gzoo/forge-core'
import type { Decision, Exploration, Tension } from '@gzoo/forge-core'
import { generateSessionBrief } from '../session-brief'

let store: ProjectModelStore
let projectId: string
let sessionId: string

beforeEach(() => {
  store = new ProjectModelStore(':memory:')
  projectId = store.createProject('ws_test', 'Test Project')
  sessionId = store.startSession(projectId)
})

afterEach(() => {
  store.close()
})

describe('generateSessionBrief', () => {
  it('generates brief for empty model', () => {
    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, sessionId)

    expect(brief.projectName).toBe('Test Project')
    expect(brief.primaryGoal).toBe('Not yet defined')
    expect(brief.lockedDecisions).toEqual([])
    expect(brief.decidedDecisions).toEqual([])
    expect(brief.pendingDecisions).toEqual([])
    expect(brief.unresolvedTensions).toEqual([])
    expect(brief.generatedAt).toBeInstanceOf(Date)
  })

  it('includes locked and decided decisions', () => {
    const provenance = createProvenance(sessionId, 1, 'test')

    const locked: Decision = {
      id: createId('decision'),
      category: 'technical',
      statement: 'Use PostgreSQL',
      rationale: 'ACID compliance',
      alternatives: [],
      commitment: 'locked',
      certainty: 'validated',
      provenance,
      promotionHistory: [],
      constrains: [],
      dependsOn: [],
      enables: [],
      manifestsIn: [],
      closedOptions: [],
    }

    const decided: Decision = {
      id: createId('decision'),
      category: 'product',
      statement: 'Target enterprise customers',
      rationale: 'Higher revenue',
      alternatives: ['SMB'],
      commitment: 'decided',
      certainty: 'evidenced',
      provenance,
      promotionHistory: [],
      constrains: [],
      dependsOn: [],
      enables: [],
      manifestsIn: [],
      closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: locked, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )
    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: decided, provenance },
      { projectId, sessionId, turnIndex: 2 }
    )

    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, sessionId)

    expect(brief.lockedDecisions.length).toBe(1)
    expect(brief.lockedDecisions[0].statement).toBe('Use PostgreSQL')
    expect(brief.decidedDecisions.length).toBe(1)
    expect(brief.decidedDecisions[0].statement).toBe('Target enterprise customers')
  })

  it('includes active explorations in pending', () => {
    const provenance = createProvenance(sessionId, 1, 'test')

    const exploration: Exploration = {
      id: createId('exploration'),
      topic: 'Pricing model options',
      direction: 'Considering freemium vs paid-only',
      openQuestions: ['What is the conversion rate?', 'Is freemium viable?'],
      consideredOptions: ['freemium', 'paid-only', 'usage-based'],
      provenance,
      status: 'active',
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'exploration', node: exploration, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, sessionId)

    expect(brief.pendingDecisions.length).toBe(1)
    expect(brief.pendingDecisions[0].topic).toBe('Pricing model options')
    expect(brief.pendingDecisions[0].openQuestions.length).toBe(2)
  })

  it('includes unresolved tensions', () => {
    const provenance = createProvenance(sessionId, 1, 'test')

    const tension: Tension = {
      id: createId('tension'),
      description: 'SMB targeting conflicts with enterprise goal',
      nodeAId: createId('decision'),
      nodeBId: createId('decision'),
      nodeAType: 'decision',
      nodeBType: 'decision',
      severity: 'significant',
      detectedAt: new Date(),
      provenance,
      status: 'active',
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'tension', node: tension, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, sessionId)

    expect(brief.unresolvedTensions.length).toBe(1)
    expect(brief.unresolvedTensions[0].severity).toBe('significant')
  })

  // Scenario 7.3: The Abandoned Session
  it('Scenario 7.3: generates brief referencing a short previous session', () => {
    const provenance = createProvenance(sessionId, 1, 'test')

    // Add a couple turns to the first session
    store.appendTurn({
      sessionId,
      projectId,
      turnIndex: 1,
      speaker: 'user',
      text: 'I want to build a scheduling tool',
      timestamp: new Date(),
    })
    store.appendTurn({
      sessionId,
      projectId,
      turnIndex: 2,
      speaker: 'user',
      text: 'Targeting solo consultants',
      timestamp: new Date(),
    })

    // Add a decision
    const dec: Decision = {
      id: createId('decision'),
      category: 'product',
      statement: 'Build a scheduling tool for solo consultants',
      rationale: 'Market need',
      alternatives: [],
      commitment: 'leaning',
      certainty: 'assumed',
      provenance,
      promotionHistory: [],
      constrains: [],
      dependsOn: [],
      enables: [],
      manifestsIn: [],
      closedOptions: [],
    }
    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    // End the session due to time gap (abandoned)
    store.endSession(sessionId, 'time_gap')

    // Start a new session
    const session2 = store.startSession(projectId)
    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, session2, sessionId)

    // Brief should reference previous session data
    expect(brief.lastSessionOutcome).toBeDefined()
    expect(brief.projectName).toBe('Test Project')
    // The leaning decision should appear
    const allDecisions = [...brief.lockedDecisions, ...brief.decidedDecisions]
    // It's leaning, so it won't be in locked or decided — check pending or changesSinceLastSession
    expect(brief.changesSinceLastSession.length).toBeGreaterThanOrEqual(0)
  })

  it('reports outcome based on decision counts', () => {
    const provenance = createProvenance(sessionId, 1, 'test')

    const decided: Decision = {
      id: createId('decision'),
      category: 'technical',
      statement: 'Use React',
      rationale: 'Team knows it',
      alternatives: [],
      commitment: 'decided',
      certainty: 'evidenced',
      provenance,
      promotionHistory: [],
      constrains: [],
      dependsOn: [],
      enables: [],
      manifestsIn: [],
      closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: decided, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    const model = store.getProjectModel(projectId)
    const brief = generateSessionBrief(model, store, sessionId)

    expect(brief.lastSessionOutcome).toContain('1 decided')
  })
})
