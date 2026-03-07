import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExecutionEngine } from '../engine'
import type { ExecutionHook, ProposedAction, ActionResult } from '../types'
import type { ExecutionAction, ProjectModel, NodeId } from '@gzoo/forge-core'
import { createId, createProvenance } from '@gzoo/forge-core'

// ── Mock Store ──────────────────────────────────────────────────────────────

class MockStore {
  close() {}
}

// ── Mock Hook ───────────────────────────────────────────────────────────────

function createMockHook(overrides: Partial<ExecutionHook> = {}): ExecutionHook {
  return {
    service: 'mock',
    description: 'Mock hook for testing',
    isConfigured: () => true,
    propose: async () => [],
    execute: async () => ({ success: true, data: { result: 'ok' } }),
    ...overrides,
  }
}

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine

  beforeEach(() => {
    engine = new ExecutionEngine(new MockStore() as any, createId('project'))
  })

  it('registers and lists hooks', () => {
    const hook = createMockHook()
    engine.registerHook(hook)
    expect(engine.getRegisteredHooks()).toEqual(['mock'])
  })

  it('creates an action from a proposal', () => {
    const proposal: ProposedAction = {
      description: 'Create repo',
      service: 'github',
      actionType: 'create_repo',
      parameters: { name: 'test-repo' },
      requiresApproval: true,
      isReversible: true,
      reason: 'Test',
    }

    const action = engine.createAction(proposal)

    expect(action.description).toBe('Create repo')
    expect(action.service).toBe('github')
    expect(action.status).toBe('pending')
    expect(action.requiresApproval).toBe(true)
    expect(action.isReversible).toBe(true)
  })

  it('approves a pending action', async () => {
    const proposal: ProposedAction = {
      description: 'Test action',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      reason: 'Test',
    }

    const action = engine.createAction(proposal)
    const approved = await engine.approveAction(action.id, 'sess_test')

    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe('sess_test')
    expect(approved.approvedAt).toBeInstanceOf(Date)
  })

  it('throws when approving a non-pending action', async () => {
    const proposal: ProposedAction = {
      description: 'Test',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      reason: 'Test',
    }

    const action = engine.createAction(proposal)
    await engine.approveAction(action.id, 'sess_test')

    await expect(engine.approveAction(action.id, 'sess_test'))
      .rejects.toThrow('not pending')
  })

  it('executes an approved action', async () => {
    const hook = createMockHook({
      execute: async () => ({ success: true, data: { repoUrl: 'https://github.com/test/repo' } }),
    })
    engine.registerHook(hook)

    const action = engine.createAction({
      description: 'Test',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      requiresApproval: true,
      reason: 'Test',
    })

    await engine.approveAction(action.id, 'sess_test')
    const result = await engine.executeAction(action.id)

    expect(result.success).toBe(true)
    expect(result.data?.repoUrl).toBe('https://github.com/test/repo')

    const completed = engine.getAction(action.id)
    expect(completed?.status).toBe('completed')
    expect(completed?.completedAt).toBeInstanceOf(Date)
  })

  it('refuses to execute unapproved action that requires approval', async () => {
    engine.registerHook(createMockHook())

    const action = engine.createAction({
      description: 'Test',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      requiresApproval: true,
      reason: 'Test',
    })

    await expect(engine.executeAction(action.id))
      .rejects.toThrow('requires approval')
  })

  it('handles execution failure gracefully', async () => {
    const hook = createMockHook({
      execute: async () => { throw new Error('API rate limited') },
    })
    engine.registerHook(hook)

    const action = engine.createAction({
      description: 'Test',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      requiresApproval: true,
      reason: 'Test',
    })

    await engine.approveAction(action.id, 'sess_test')
    const result = await engine.executeAction(action.id)

    expect(result.success).toBe(false)
    expect(result.error).toBe('API rate limited')

    const failed = engine.getAction(action.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('API rate limited')
  })

  it('approveAndExecute does both in one call', async () => {
    const hook = createMockHook({
      execute: async () => ({ success: true, data: { done: true } }),
    })
    engine.registerHook(hook)

    const action = engine.createAction({
      description: 'Test',
      service: 'mock',
      actionType: 'test',
      parameters: {},
      requiresApproval: true,
      reason: 'Test',
    })

    const result = await engine.approveAndExecute(action.id, 'sess_test')
    expect(result.success).toBe(true)

    const completed = engine.getAction(action.id)
    expect(completed?.status).toBe('completed')
    expect(completed?.approvedBy).toBe('sess_test')
  })

  it('proposes actions from registered hooks', async () => {
    const hook = createMockHook({
      propose: async () => [
        {
          description: 'Create repo',
          service: 'mock',
          actionType: 'create_repo',
          parameters: {},
          reason: 'Test proposal',
        },
      ],
    })
    engine.registerHook(hook)

    const model = createEmptyModel()
    const proposals = await engine.proposeActions(model)

    expect(proposals).toHaveLength(1)
    expect(proposals[0].description).toBe('Create repo')
  })

  it('skips unconfigured hooks during proposal', async () => {
    const hook = createMockHook({
      isConfigured: () => false,
      propose: async () => [
        { description: 'Should not appear', service: 'mock', actionType: 'test', parameters: {}, reason: 'Test' },
      ],
    })
    engine.registerHook(hook)

    const model = createEmptyModel()
    const proposals = await engine.proposeActions(model)

    expect(proposals).toHaveLength(0)
  })

  it('queries actions by status', () => {
    engine.registerHook(createMockHook())

    const a1 = engine.createAction({ description: 'A', service: 'mock', actionType: 'test', parameters: {}, reason: '1' })
    const a2 = engine.createAction({ description: 'B', service: 'mock', actionType: 'test', parameters: {}, reason: '2' })

    expect(engine.getPendingActions()).toHaveLength(2)
    expect(engine.getCompletedActions()).toHaveLength(0)
    expect(engine.getAllActions()).toHaveLength(2)
  })
})
