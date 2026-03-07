import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ProjectModelStore } from '../store'
import { createProvenance, createId } from '@gzoo/forge-core'
import type { Decision, Rejection, Exploration } from '@gzoo/forge-core'

let store: ProjectModelStore

beforeEach(() => {
  store = new ProjectModelStore(':memory:')
})

afterEach(() => {
  store.close()
})

// ── Workspace Lifecycle ─────────────────────────────────────────────────────

describe('Workspace lifecycle', () => {
  it('creates a workspace and retrieves it', () => {
    const wsId = store.createWorkspace('Test Workspace')
    const ws = store.getWorkspace(wsId)

    expect(ws).not.toBeNull()
    expect(ws!.name).toBe('Test Workspace')
    expect(ws!.projectIds).toEqual([])
    expect(ws!.riskProfile.technical).toBe('moderate')
  })

  it('links projects to workspace via createProject', () => {
    const wsId = store.createWorkspace('My Workspace')
    const p1 = store.createProject(wsId, 'Project Alpha')
    const p2 = store.createProject(wsId, 'Project Beta')

    const ws = store.getWorkspace(wsId)
    expect(ws!.projectIds).toContain(p1)
    expect(ws!.projectIds).toContain(p2)
    expect(ws!.projectIds.length).toBe(2)
  })

  it('auto-creates ws_default when it does not exist', () => {
    const projectId = store.createProject('ws_default', 'Auto Project')
    const ws = store.getWorkspace('ws_default')

    expect(ws).not.toBeNull()
    expect(ws!.name).toBe('Default Workspace')
    expect(ws!.projectIds).toContain(projectId)
  })
})

// ── Cross-Project Memory ────────────────────────────────────────────────────

describe('Cross-project memory queries', () => {
  function addDecisionToProject(projectId: string, sessionId: string, statement: string, opts?: {
    category?: string
    commitment?: string
    certainty?: string
  }) {
    const provenance = createProvenance(sessionId, 1, statement)
    const decId = createId('decision')
    const decision: Decision = {
      id: decId,
      category: (opts?.category ?? 'technical') as Decision['category'],
      statement,
      rationale: 'Test rationale',
      alternatives: [],
      commitment: (opts?.commitment ?? 'decided') as Decision['commitment'],
      certainty: (opts?.certainty ?? 'evidenced') as Decision['certainty'],
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
    return decId
  }

  function addRejectionToProject(projectId: string, sessionId: string, statement: string, opts?: {
    category?: string
    reason?: string
    revealsPreference?: string
    rejectionType?: string
  }) {
    const provenance = createProvenance(sessionId, 1, statement)
    const rejId = createId('rejection')
    const rejection: Rejection = {
      id: rejId,
      category: (opts?.category ?? 'technical') as Rejection['category'],
      statement,
      rejectionType: (opts?.rejectionType ?? 'categorical') as Rejection['rejectionType'],
      reason: opts?.reason ?? 'Not a fit',
      provenance,
      revealsPreference: opts?.revealsPreference,
      contributesToValues: !!opts?.revealsPreference,
    }
    store.appendEvent(
      { type: 'NODE_CREATED', nodeType: 'rejection', node: rejection, provenance },
      { projectId, sessionId, turnIndex: 1 }
    )
    return rejId
  }

  it('finds relevant decisions from other projects', () => {
    const wsId = store.createWorkspace('Multi')
    const p1 = store.createProject(wsId, 'Project Alpha')
    const s1 = store.startSession(p1)
    addDecisionToProject(p1, s1, 'Use PostgreSQL for the main database')

    const p2 = store.createProject(wsId, 'Project Beta')
    const s2 = store.startSession(p2)
    addDecisionToProject(p2, s2, 'Build a REST API with Express')

    // Query from a third project perspective
    const p3 = store.createProject(wsId, 'Project Gamma')
    const result = store.queryMemory({
      currentDecision: 'Which database should we use? PostgreSQL seems good.',
      excludeProjectId: p3,
    })

    expect(result.matches.length).toBeGreaterThan(0)
    const pgMatch = result.matches.find(m => m.statement.includes('PostgreSQL'))
    expect(pgMatch).toBeDefined()
    expect(pgMatch!.projectName).toBe('Project Alpha')
    expect(pgMatch!.nodeType).toBe('decision')
  })

  it('excludes the current project from results', () => {
    const wsId = store.createWorkspace('Self')
    const p1 = store.createProject(wsId, 'Only Project')
    const s1 = store.startSession(p1)
    addDecisionToProject(p1, s1, 'Use PostgreSQL for the main database')

    const result = store.queryMemory({
      currentDecision: 'PostgreSQL database',
      excludeProjectId: p1,
    })

    expect(result.matches.length).toBe(0)
  })

  it('finds relevant rejections with bonus relevance', () => {
    const wsId = store.createWorkspace('RejTest')
    const p1 = store.createProject(wsId, 'Old Project')
    const s1 = store.startSession(p1)
    addRejectionToProject(p1, s1, 'MongoDB for the main database', {
      reason: 'Lacks ACID compliance for our needs',
      revealsPreference: 'Prefers relational databases with ACID compliance',
    })

    const p2 = store.createProject(wsId, 'New Project')
    const result = store.queryMemory({
      currentDecision: 'Should we use MongoDB for the database?',
      excludeProjectId: p2,
    })

    const mongoMatch = result.matches.find(m => m.statement.includes('MongoDB'))
    expect(mongoMatch).toBeDefined()
    expect(mongoMatch!.nodeType).toBe('rejection')
    expect(mongoMatch!.outcome).toContain('Rejected')
  })

  it('returns empty for unrelated queries', () => {
    const wsId = store.createWorkspace('Unrelated')
    const p1 = store.createProject(wsId, 'Color Project')
    const s1 = store.startSession(p1)
    addDecisionToProject(p1, s1, 'Use blue as the primary brand color')

    const p2 = store.createProject(wsId, 'DB Project')
    const result = store.queryMemory({
      currentDecision: 'PostgreSQL database configuration',
      excludeProjectId: p2,
    })

    expect(result.matches.length).toBe(0)
  })

  it('caps results at 5 matches', () => {
    const wsId = store.createWorkspace('Many')
    const searchTerm = 'microservice architecture deployment'

    // Create 8 projects with similar decisions
    for (let i = 0; i < 8; i++) {
      const pid = store.createProject(wsId, `Project ${i}`)
      const sid = store.startSession(pid)
      addDecisionToProject(pid, sid, `Deploy microservice architecture component ${i}`)
    }

    const pNew = store.createProject(wsId, 'Query Project')
    const result = store.queryMemory({
      currentDecision: searchTerm,
      excludeProjectId: pNew,
    })

    expect(result.matches.length).toBeLessThanOrEqual(5)
  })
})

// ── Values Model ────────────────────────────────────────────────────────────

describe('Values model building', () => {
  it('builds preferences from categorical rejections', () => {
    const wsId = store.createWorkspace('Values')
    const p1 = store.createProject(wsId, 'P1')
    const s1 = store.startSession(p1)

    const provenance = createProvenance(s1, 1, 'No PHP')
    store.appendEvent({
      type: 'NODE_CREATED',
      nodeType: 'rejection',
      node: {
        id: createId('rejection'),
        category: 'technical',
        statement: 'No PHP',
        rejectionType: 'categorical',
        reason: 'Not modern enough',
        provenance,
        revealsPreference: 'Prefers modern typed languages',
        contributesToValues: true,
      },
      provenance,
    }, { projectId: p1, sessionId: s1, turnIndex: 1 })

    const p2 = store.createProject(wsId, 'P2')
    const s2 = store.startSession(p2)
    const prov2 = createProvenance(s2, 1, 'No Java')
    store.appendEvent({
      type: 'NODE_CREATED',
      nodeType: 'rejection',
      node: {
        id: createId('rejection'),
        category: 'technical',
        statement: 'No Java',
        rejectionType: 'categorical',
        reason: 'Too verbose',
        provenance: prov2,
        revealsPreference: 'Prefers modern typed languages',
        contributesToValues: true,
      },
      provenance: prov2,
    }, { projectId: p2, sessionId: s2, turnIndex: 1 })

    const values = store.buildValuesModel(wsId)

    expect(values.inferredPreferences.length).toBe(1)
    const pref = values.inferredPreferences[0]
    expect(pref.statement).toBe('Prefers modern typed languages')
    expect(pref.evidenceCount).toBe(2)
    expect(pref.confidence).toBe('medium')
    expect(pref.sourceProjectIds.length).toBe(2)
  })

  it('returns empty preferences when no categorical rejections exist', () => {
    const wsId = store.createWorkspace('Empty')
    store.createProject(wsId, 'P1')

    const values = store.buildValuesModel(wsId)
    expect(values.inferredPreferences.length).toBe(0)
  })
})

// ── Risk Profile ────────────────────────────────────────────────────────────

describe('Risk profile inference', () => {
  it('infers moderate profile with no decisions', () => {
    const wsId = store.createWorkspace('NoData')
    store.createProject(wsId, 'Empty')

    const profile = store.inferRiskProfile(wsId)
    expect(profile.technical).toBe('moderate')
    expect(profile.market).toBe('moderate')
    expect(profile.financial).toBe('moderate')
  })

  it('infers conservative technical profile from validated decisions', () => {
    const wsId = store.createWorkspace('Conservative')
    const p1 = store.createProject(wsId, 'Safe Project')
    const s1 = store.startSession(p1)
    const provenance = createProvenance(s1, 1, 'test')

    // Add several validated technical decisions
    for (let i = 0; i < 5; i++) {
      const decision: Decision = {
        id: createId('decision'),
        category: 'technical',
        statement: `Validated tech decision ${i}`,
        rationale: 'Well-tested',
        alternatives: [],
        commitment: 'decided',
        certainty: 'validated',
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
        { projectId: p1, sessionId: s1, turnIndex: 1 }
      )
    }

    const profile = store.inferRiskProfile(wsId)
    expect(profile.technical).toBe('conservative')
  })
})
