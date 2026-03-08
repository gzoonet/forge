import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ProjectModelStore } from '../store'
import { createProvenance, createId } from '@gzoo/forge-core'
import type { Decision, Constraint, Exploration, Artifact, ArtifactSection } from '@gzoo/forge-core'
import {
  getDecisionsByCommitment,
  getActiveExplorations,
  getUnresolvedTensions,
  getDependentsOf,
} from '../queries'

let store: ProjectModelStore

beforeEach(() => {
  store = new ProjectModelStore(':memory:')
})

afterEach(() => {
  store.close()
})

describe('ProjectModelStore — project lifecycle', () => {
  it('creates a project and retrieves empty model', () => {
    const projectId = store.createProject('ws_test', 'Test Project')

    const model = store.getProjectModel(projectId)
    expect(model.id).toBe(projectId)
    expect(model.name).toBe('Test Project')
    expect(model.workspaceId).toBe('ws_test')
    expect(model.decisions.size).toBe(0)
    expect(model.constraints.size).toBe(0)
  })
})

describe('ProjectModelStore — event append and replay', () => {
  it('appends events and rebuilds model', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'Let us use Postgres')

    const decisionId = createId('decision')
    const decision: Decision = {
      id: decisionId,
      category: 'technical',
      statement: 'We will use PostgreSQL for the database',
      rationale: 'Robust and well-known',
      alternatives: ['SQLite', 'MySQL'],
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
      { type: 'NODE_CREATED', nodeType: 'decision', node: decision, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(1)
    expect(model.decisions.get(decisionId)?.statement).toBe('We will use PostgreSQL for the database')
    expect(model.decisions.get(decisionId)?.commitment).toBe('decided')
  })

  it('replays events to get model at a specific point', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    const dec1Id = createId('decision')
    const dec1: Decision = {
      id: dec1Id, category: 'technical', statement: 'Decision 1',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    const event1 = store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec1, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    const dec2Id = createId('decision')
    const dec2: Decision = {
      id: dec2Id, category: 'product', statement: 'Decision 2',
      rationale: '', alternatives: [], commitment: 'leaning', certainty: 'uncertain',
      provenance: createProvenance(sessionId, 2, 'turn 2'), promotionHistory: [],
      constrains: [], dependsOn: [], enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec2, provenance: dec2.provenance },
      { projectId, sessionId, turnIndex: 2 }
    )

    // Model at event1 should only have decision 1
    const modelAtEvent1 = store.getProjectModelAtEvent(projectId, event1.eventId)
    expect(modelAtEvent1.decisions.size).toBe(1)
    expect(modelAtEvent1.decisions.has(dec1Id)).toBe(true)

    // Current model should have both
    const currentModel = store.getProjectModel(projectId)
    expect(currentModel.decisions.size).toBe(2)
  })
})

describe('ProjectModelStore — sessions', () => {
  it('starts and ends sessions', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)

    expect(sessionId).toMatch(/^sess_/)

    store.endSession(sessionId, 'explicit_close')

    const model = store.getProjectModel(projectId)
    expect(model.sessionIds).toContain(sessionId)
  })

  it('throws when ending nonexistent session', () => {
    expect(() => store.endSession('sess_nonexistent', 'explicit_close'))
      .toThrow('Session not found')
  })
})

describe('ProjectModelStore — turns', () => {
  it('appends and retrieves turns', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)

    store.appendTurn({
      sessionId,
      projectId,
      turnIndex: 1,
      speaker: 'user',
      text: 'I want to build a SaaS product',
      timestamp: new Date(),
    })

    store.appendTurn({
      sessionId,
      projectId,
      turnIndex: 2,
      speaker: 'system',
      text: 'Tell me more about your target market.',
      timestamp: new Date(),
    })

    const turns = store.getSessionTurns(sessionId)
    expect(turns).toHaveLength(2)
    expect(turns[0].speaker).toBe('user')
    expect(turns[1].speaker).toBe('system')
    expect(turns[0].turnIndex).toBe(1)
  })
})

describe('ProjectModelStore — node promotion', () => {
  it('promotes a decision and records promotion history', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    const decId = createId('decision')
    const decision: Decision = {
      id: decId, category: 'technical', statement: 'Use React',
      rationale: '', alternatives: [], commitment: 'exploring', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: decision, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    store.appendEvent(
      {
        type: 'NODE_PROMOTED',
        nodeId: decId,
        from: 'exploring',
        to: 'leaning',
        trigger: 'comparative_preference',
        wasAutomatic: true,
        provenance: createProvenance(sessionId, 3, 'React seems better'),
      },
      { projectId, sessionId, turnIndex: 3 }
    )

    const model = store.getProjectModel(projectId)
    const promoted = model.decisions.get(decId)!
    expect(promoted.commitment).toBe('leaning')
    expect(promoted.promotionHistory).toHaveLength(1)
    expect(promoted.promotionHistory[0].trigger).toBe('comparative_preference')
    expect(promoted.promotionHistory[0].wasAutomatic).toBe(true)
  })
})

describe('ProjectModelStore — intent updates', () => {
  it('updates the primary goal', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'Build a dispatch SaaS')

    store.appendEvent(
      {
        type: 'INTENT_UPDATED',
        projectId,
        field: 'primaryGoal',
        value: {
          statement: 'Build a dispatch SaaS for HVAC companies',
          successCriteria: ['10 paying customers'],
          provenance,
          commitment: 'decided' as const,
        },
        provenance,
      },
      { projectId, sessionId, turnIndex: 1 }
    )

    const model = store.getProjectModel(projectId)
    expect(model.intent.primaryGoal?.statement).toBe('Build a dispatch SaaS for HVAC companies')
  })
})

describe('ProjectModelStore — corrections', () => {
  it('applies a correction to an existing node', () => {
    const projectId = store.createProject('ws_test', 'Test Project')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'target freelancers')

    const conId = createId('constraint')
    const constraint: Constraint = {
      id: conId, type: 'market', statement: 'Target freelancers',
      source: 'stated', hardness: 'hard', certainty: 'assumed', provenance,
      propagatesTo: [], isRevealed: false, scope: 'project',
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'constraint', node: constraint, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    store.appendEvent(
      {
        type: 'CORRECTION_APPLIED',
        targetNodeId: conId,
        changes: { statement: 'Target small agencies, 5-15 person teams' },
        provenance: createProvenance(sessionId, 5, 'Actually, agencies not freelancers'),
      },
      { projectId, sessionId, turnIndex: 5 }
    )

    const model = store.getProjectModel(projectId)
    expect(model.constraints.get(conId)?.statement).toBe('Target small agencies, 5-15 person teams')
  })
})

describe('ProjectModelStore — query helpers', () => {
  it('filters decisions by commitment level', () => {
    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    const dec1: Decision = {
      id: createId('decision'), category: 'technical', statement: 'Use Postgres',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }
    const dec2: Decision = {
      id: createId('decision'), category: 'product', statement: 'Maybe dark mode',
      rationale: '', alternatives: [], commitment: 'exploring', certainty: 'uncertain',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec1, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )
    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec2, provenance },
      { projectId, sessionId, turnIndex: 2 }
    )

    const model = store.getProjectModel(projectId)
    expect(getDecisionsByCommitment(model, 'decided')).toHaveLength(1)
    expect(getDecisionsByCommitment(model, 'exploring')).toHaveLength(1)
    expect(getDecisionsByCommitment(model, 'leaning')).toHaveLength(0)
  })

  it('finds dependents of a decision', () => {
    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    const parentId = createId('decision')
    const parent: Decision = {
      id: parentId, category: 'technical', statement: 'Use Postgres',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }
    const child: Decision = {
      id: createId('decision'), category: 'technical', statement: 'Use Prisma ORM',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [parentId],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: parent, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )
    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: child, provenance },
      { projectId, sessionId, turnIndex: 2 }
    )

    const model = store.getProjectModel(projectId)
    const deps = getDependentsOf(model, parentId)
    expect(deps).toHaveLength(1)
    expect(deps[0].statement).toBe('Use Prisma ORM')
  })
})

// ─── Scenario 6.2: Section-Level Artifact Approval ──────────────────────────

describe('Scenario 6.2 — Artifact section status updates', () => {
  it('updates individual section status without affecting other sections', () => {
    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'artifact')

    const rootSectionId = createId('artifact') as string
    const section2Id = createId('artifact') as string

    const artifact: Artifact = {
      id: createId('artifact'),
      type: 'spec',
      name: 'Architecture Spec',
      description: 'Technical architecture document',
      status: 'draft',
      provenance,
      sourceDecisionIds: [],
      sourceConstraintIds: [],
      sections: new Map([
        [rootSectionId, {
          id: rootSectionId,
          artifactId: '',
          title: 'Overview',
          content: { format: 'markdown', body: '# Overview' },
          status: 'draft',
          version: 1,
          childSectionIds: [section2Id],
          sourceDecisionIds: [],
          sourceConstraintIds: [],
          provenance,
        } as ArtifactSection],
        [section2Id, {
          id: section2Id,
          artifactId: '',
          parentSectionId: rootSectionId,
          title: 'Database Design',
          content: { format: 'markdown', body: '## Database' },
          status: 'draft',
          version: 1,
          childSectionIds: [],
          sourceDecisionIds: [],
          sourceConstraintIds: [],
          provenance,
        } as ArtifactSection],
      ]),
      rootSectionId,
      version: '1',
      fullyCommitted: false,
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'artifact', node: artifact, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    // Approve root section, reject section 2
    store.appendEvent(
      {
        type: 'NODE_UPDATED',
        nodeId: artifact.id,
        nodeType: 'artifact',
        changes: {
          [`sections.${rootSectionId}.status`]: 'approved',
          [`sections.${section2Id}.status`]: 'rejected',
        },
        provenance: createProvenance(sessionId, 2, 'review'),
      },
      { projectId, sessionId, turnIndex: 2 }
    )

    const model = store.getProjectModel(projectId)
    const art = model.artifacts.get(artifact.id)
    expect(art).toBeDefined()
    // The artifact should exist and not be fully committed
    expect(art!.fullyCommitted).toBe(false)
  })
})

describe('ProjectModelStore — model cache', () => {
  it('caches and retrieves model correctly', () => {
    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    const dec: Decision = {
      id: createId('decision'), category: 'technical', statement: 'Use Postgres',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    // First call rebuilds and caches
    const model1 = store.getProjectModel(projectId)
    // Second call should hit cache
    const model2 = store.getProjectModel(projectId)

    expect(model1.decisions.size).toBe(1)
    expect(model2.decisions.size).toBe(1)
    expect(model2.decisions.get(dec.id)?.statement).toBe('Use Postgres')
  })

  it('invalidates cache when new events are appended', () => {
    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)
    const provenance = createProvenance(sessionId, 1, 'turn')

    // Build cache
    store.getProjectModel(projectId)

    // Append new event
    const dec: Decision = {
      id: createId('decision'), category: 'technical', statement: 'New decision',
      rationale: '', alternatives: [], commitment: 'decided', certainty: 'assumed',
      provenance, promotionHistory: [], constrains: [], dependsOn: [],
      enables: [], manifestsIn: [], closedOptions: [],
    }

    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'decision', node: dec, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )

    // Should rebuild from events, not use stale cache
    const model = store.getProjectModel(projectId)
    expect(model.decisions.size).toBe(1)
  })
})
