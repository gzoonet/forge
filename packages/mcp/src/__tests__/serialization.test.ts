import { describe, it, expect } from 'vitest'
import { formatBriefAsMarkdown, formatDiffAsMarkdown, serializeModel, serializeTensions } from '../serialization'
import type { SessionBrief, ProjectModel } from '@gzoo/forge-core'
import type { StoredEvent, StoredTurn } from '@gzoo/forge-store'

describe('formatBriefAsMarkdown', () => {
  it('renders empty brief', () => {
    const brief: SessionBrief = {
      generatedAt: new Date('2026-03-08T00:00:00Z'),
      projectName: 'Test Project',
      primaryGoal: 'Not yet defined',
      lockedDecisions: [],
      decidedDecisions: [],
      pendingDecisions: [],
      unresolvedTensions: [],
      changesSinceLastSession: [],
      lastSessionGoal: '',
      lastSessionOutcome: 'No committed decisions yet',
      artifactsInProgress: [],
      recentlyCommitted: [],
    }

    const md = formatBriefAsMarkdown(brief)
    expect(md).toContain('# Project: Test Project')
    expect(md).toContain('Not yet defined')
    expect(md).not.toContain('## Locked Decisions')
    expect(md).not.toContain('## Decided')
  })

  it('renders brief with decisions and tensions', () => {
    const brief: SessionBrief = {
      generatedAt: new Date('2026-03-08T00:00:00Z'),
      projectName: 'Acme SaaS',
      primaryGoal: 'Build an analytics dashboard',
      lockedDecisions: [
        { statement: 'Use TypeScript', commitment: 'locked', category: 'technical' },
      ],
      decidedDecisions: [
        { statement: 'Stripe for payments', commitment: 'decided', category: 'business' },
      ],
      pendingDecisions: [
        { topic: 'Auth approach', openQuestions: ['Auth0 vs Clerk?'] },
      ],
      unresolvedTensions: [
        { description: 'Timeline conflicts with custom auth', severity: 'significant' },
      ],
      changesSinceLastSession: ['New decision: Use TypeScript'],
      lastSessionGoal: 'Build an analytics dashboard',
      lastSessionOutcome: '1 decided, 1 locked',
      artifactsInProgress: [
        { name: 'Architecture Spec', type: 'spec', status: 'draft', sectionsInProgress: 2, sectionsCommitted: 1 },
      ],
      recentlyCommitted: [],
    }

    const md = formatBriefAsMarkdown(brief)
    expect(md).toContain('# Project: Acme SaaS')
    expect(md).toContain('Build an analytics dashboard')
    expect(md).toContain('## Locked Decisions')
    expect(md).toContain('**Use TypeScript** [technical]')
    expect(md).toContain('## Decided')
    expect(md).toContain('Stripe for payments [business]')
    expect(md).toContain('## Pending Explorations')
    expect(md).toContain('Auth approach')
    expect(md).toContain('Auth0 vs Clerk?')
    expect(md).toContain('## Active Tensions')
    expect(md).toContain('[significant] Timeline conflicts with custom auth')
    expect(md).toContain('## Artifacts In Progress')
    expect(md).toContain('Architecture Spec')
    expect(md).toContain('## Changes Since Last Session')
    expect(md).toContain('New decision: Use TypeScript')
  })
})

describe('serializeTensions', () => {
  it('filters to active and acknowledged tensions', () => {
    const model = {
      decisions: new Map(),
      constraints: new Map(),
      explorations: new Map(),
      tensions: new Map([
        ['t1', {
          id: 't1', description: 'Active one', severity: 'significant',
          status: 'active', nodeAId: 'a', nodeBId: 'b',
          nodeAType: 'decision', nodeBType: 'constraint',
        }],
        ['t2', {
          id: 't2', description: 'Resolved one', severity: 'minor',
          status: 'resolved', nodeAId: 'c', nodeBId: 'd',
          nodeAType: 'decision', nodeBType: 'decision',
        }],
      ]),
    } as unknown as ProjectModel

    const result = serializeTensions(model)
    expect(result.length).toBe(1)
    expect(result[0].description).toBe('Active one')
  })
})

describe('formatDiffAsMarkdown', () => {
  const baseModel = {
    decisions: new Map([
      ['dec_1', { id: 'dec_1', statement: 'Use TypeScript', commitment: 'decided', category: 'technical' }],
    ]),
    constraints: new Map(),
    explorations: new Map(),
    tensions: new Map(),
  } as unknown as ProjectModel

  it('renders turn with no changes', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 1, speaker: 'user', text: 'Hello world',
      timestamp: new Date(), classification: [{ type: 'noise', confidence: 'high' }],
    }
    const md = formatDiffAsMarkdown(turn, [], baseModel)
    expect(md).toContain('# Turn 1 Diff')
    expect(md).toContain('noise')
    expect(md).toContain('Hello world')
    expect(md).toContain('No model changes this turn')
  })

  it('renders NODE_CREATED events', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 2, speaker: 'user', text: 'Use TypeScript for everything',
      timestamp: new Date(), classification: [{ type: 'decision', confidence: 'high' }],
    }
    const events: StoredEvent[] = [{
      type: 'NODE_CREATED', nodeType: 'decision',
      node: { id: 'dec_2', statement: 'Use TypeScript', commitment: 'exploring', category: 'technical', rationale: 'Type safety' },
      provenance: { sessionId: 's1', turnIndex: 2, rawText: 'Use TypeScript' },
      eventId: 'e1', projectId: 'p1' as any, sessionId: 's1', turnIndex: 2, storedAt: new Date(),
    } as any]

    const md = formatDiffAsMarkdown(turn, events, baseModel)
    expect(md).toContain('## Changes (1)')
    expect(md).toContain('[decision] Use TypeScript')
    expect(md).toContain('Commitment: exploring')
    expect(md).toContain('Category: technical')
    expect(md).toContain('Rationale: Type safety')
  })

  it('renders NODE_PROMOTED events', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 3, speaker: 'user', text: 'Yes, definitely TypeScript',
      timestamp: new Date(),
    }
    const events: StoredEvent[] = [{
      type: 'NODE_PROMOTED', nodeId: 'dec_1',
      from: 'leaning', to: 'decided', trigger: 'explicit_commitment', wasAutomatic: false,
      provenance: { sessionId: 's1', turnIndex: 3, rawText: '' },
      eventId: 'e2', projectId: 'p1' as any, sessionId: 's1', turnIndex: 3, storedAt: new Date(),
    } as any]

    const md = formatDiffAsMarkdown(turn, events, baseModel)
    expect(md).toContain('Use TypeScript: leaning → decided')
    expect(md).not.toContain('(auto)')
  })

  it('renders TENSION_DETECTED events', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 4, speaker: 'user', text: 'Also use JavaScript',
      timestamp: new Date(),
    }
    const events: StoredEvent[] = [{
      type: 'TENSION_DETECTED',
      tension: { id: 'ten_1', description: 'TypeScript vs JavaScript', severity: 'significant', nodeAId: 'dec_1', nodeBId: 'dec_2' },
      eventId: 'e3', projectId: 'p1' as any, sessionId: 's1', turnIndex: 4, storedAt: new Date(),
    } as any]

    const md = formatDiffAsMarkdown(turn, events, baseModel)
    expect(md).toContain('Tension: TypeScript vs JavaScript [significant]')
  })

  it('renders pipeline metadata from extraction result', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 5, speaker: 'user', text: 'Switch to PostgreSQL',
      timestamp: new Date(),
      extractionResult: {
        turnRef: { sessionId: 's1', turnIndex: 5 },
        classifications: [],
        modelUpdates: [],
        promotionChecks: [],
        constraintChecksTriggered: true,
        conflictChecksTriggered: true,
        escalationRequired: false,
        memoryMatches: [{ statement: 'Used MySQL before', projectName: 'OldProject', nodeType: 'decision', relevanceScore: 0.8, matchReason: 'database' }],
        cortexMatches: [{ entityType: 'class', name: 'DatabaseService', description: 'Main DB', confidence: 0.9 }, { entityType: 'file', name: 'db.ts', description: 'Config', confidence: 0.8 }],
      } as any,
    }
    const events: StoredEvent[] = [{
      type: 'NODE_CREATED', nodeType: 'decision',
      node: { id: 'dec_3', statement: 'Switch to PostgreSQL' },
      provenance: { sessionId: 's1', turnIndex: 5, rawText: '' },
      eventId: 'e4', projectId: 'p1' as any, sessionId: 's1', turnIndex: 5, storedAt: new Date(),
    } as any]

    const md = formatDiffAsMarkdown(turn, events, baseModel)
    expect(md).toContain('## Pipeline')
    expect(md).toContain('constraint propagation ran')
    expect(md).toContain('conflict detection ran')
    expect(md).toContain('1 memory match')
    expect(md).toContain('2 Cortex matches')
  })

  it('filters out SESSION_STARTED events', () => {
    const turn: StoredTurn = {
      turnId: 't1', sessionId: 's1', projectId: 'p1' as any,
      turnIndex: 1, speaker: 'user', text: 'test',
      timestamp: new Date(),
    }
    const events: StoredEvent[] = [{
      type: 'SESSION_STARTED', sessionId: 's1', projectId: 'p1' as any,
      eventId: 'e0', sessionId: 's1', turnIndex: 0, storedAt: new Date(),
    } as any]

    const md = formatDiffAsMarkdown(turn, events, baseModel)
    expect(md).toContain('No model changes this turn')
  })
})
