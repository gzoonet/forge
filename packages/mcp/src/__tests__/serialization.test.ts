import { describe, it, expect } from 'vitest'
import { formatBriefAsMarkdown, serializeModel, serializeTensions } from '../serialization'
import type { SessionBrief, ProjectModel } from '@gzoo/forge-core'

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
