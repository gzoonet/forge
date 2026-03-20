import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ForgeServer } from '../server'
import { createId, createProvenance, type Tension, type NodeId } from '@gzoo/forge-core'
import * as fs from 'fs'
import * as path from 'path'

// Use a temp directory for tests
const TEST_DIR = path.join(process.cwd(), '.forge-test-' + process.pid)
const STATE_FILE = path.join(TEST_DIR, 'state.json')

// Override cwd for state file resolution
let originalCwd: () => string

beforeEach(() => {
  originalCwd = process.cwd
  // Clean up any leftover test dir
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true })
  }
})

afterEach(() => {
  process.cwd = originalCwd
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true })
  }
})

describe('ForgeServer', () => {
  it('starts uninitialized when no state exists', () => {
    const server = new ForgeServer()
    expect(server.isInitialized()).toBe(false)
    expect(server.getProjectId()).toBeNull()
    expect(server.getSessionId()).toBeNull()
  })

  it('initializes a project', () => {
    // Need to be in a directory where we can write .forge/
    const server = new ForgeServer()
    const result = server.initProject('Test MCP Project')

    expect(result.projectId).toMatch(/^proj_/)
    expect(result.sessionId).toMatch(/^sess_/)
    expect(server.isInitialized()).toBe(true)
    expect(server.getProjectId()).toBe(result.projectId)
    expect(server.getSessionId()).toBe(result.sessionId)
    expect(server.getTurnIndex()).toBe(0)

    server.shutdown()
  })

  it('generates a brief after init', () => {
    const server = new ForgeServer()
    server.initProject('Brief Test')

    const brief = server.getBrief()
    expect(brief.projectName).toBe('Brief Test')
    expect(brief.primaryGoal).toBe('Not yet defined')
    expect(brief.lockedDecisions).toEqual([])

    server.shutdown()
  })

  it('gets model after init', () => {
    const server = new ForgeServer()
    server.initProject('Model Test')

    const model = server.getModel()
    expect(model.name).toBe('Model Test')
    expect(model.decisions.size).toBe(0)
    expect(model.constraints.size).toBe(0)

    server.shutdown()
  })

  it('approves a decision (none to approve gives error)', () => {
    const server = new ForgeServer()
    server.initProject('Approve Test')

    const result = server.approveDecision('Use PostgreSQL')
    expect(result.success).toBe(false)
    expect(result.error).toContain('No leaning decisions')

    server.shutdown()
  })

  it('queries memory without error', () => {
    const server = new ForgeServer()
    server.initProject('Memory Test')

    const result = server.queryMemory('database choice')
    expect(result.matches).toBeDefined()
    expect(Array.isArray(result.matches)).toBe(true)

    server.shutdown()
  })

  it('ends session gracefully', () => {
    const server = new ForgeServer()
    server.initProject('End Test')

    const sessionId = server.getSessionId()
    expect(sessionId).not.toBeNull()

    // Should not throw
    server.endSession('explicit_close')
    server.shutdown()
  })

  it('resumes from state after init', () => {
    // Init first server
    const server1 = new ForgeServer()
    const { projectId } = server1.initProject('Resume Test')
    server1.shutdown()

    // Resume with new server
    const server2 = new ForgeServer()
    const resumed = server2.tryResume()

    expect(resumed).toBe(true)
    expect(server2.isInitialized()).toBe(true)
    expect(server2.getProjectId()).toBe(projectId)
    // Session should be different (new session for new connection)
    expect(server2.getSessionId()).toMatch(/^sess_/)

    server2.shutdown()
  })

  it('throws when processing turn without init', () => {
    const server = new ForgeServer()

    expect(() => server.getModel()).toThrow('No active project')
    expect(() => server.getBrief()).toThrow('No active project')
  })
})

// ── Helper: seed a tension into the store ────────────────────────────────

function seedTension(
  server: ForgeServer,
  overrides: Partial<Tension> & { description: string; severity: Tension['severity'] }
): Tension {
  const store = server.getStore()!
  const projectId = server.getProjectId()!
  const sessionId = server.getSessionId()!
  const prov = createProvenance(sessionId, 0, 'test seed')

  const tension: Tension = {
    id: overrides.id ?? createId('tension'),
    description: overrides.description,
    nodeAId: overrides.nodeAId ?? createId('constraint'),
    nodeBId: overrides.nodeBId ?? createId('constraint'),
    nodeAType: overrides.nodeAType ?? 'constraint',
    nodeBType: overrides.nodeBType ?? 'constraint',
    severity: overrides.severity,
    detectedAt: new Date(),
    provenance: prov,
    status: overrides.status ?? 'active',
  }

  store.appendEvent(
    { type: 'NODE_CREATED', nodeType: 'tension', node: tension, provenance: prov },
    { projectId, sessionId, turnIndex: 0 }
  )

  return tension
}

describe('ForgeServer — tension resolution', () => {
  it('resolveTension returns error when no active tensions', () => {
    const server = new ForgeServer()
    server.initProject('Resolve Test')

    const result = server.resolveTension('anything', 'reason', 'resolve')
    expect(result.success).toBe(false)
    expect(result.error).toContain('No active tensions')

    server.shutdown()
  })

  it('resolveTension resolves a tension by hint', () => {
    const server = new ForgeServer()
    server.initProject('Resolve Test')

    seedTension(server, {
      description: 'Conflict between PostgreSQL requirement and SQLite preference',
      severity: 'significant',
    })

    const result = server.resolveTension('PostgreSQL SQLite', 'Chose PostgreSQL', 'resolve')
    expect(result.success).toBe(true)
    expect(result.description).toContain('PostgreSQL')

    // Verify tension is now resolved in the model
    const model = server.getModel()
    const resolved = Array.from(model.tensions.values()).find(t => t.id === result.tensionId)
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolution).toBe('Chose PostgreSQL')

    server.shutdown()
  })

  it('resolveTension with dismiss prepends "Dismissed:" to resolution', () => {
    const server = new ForgeServer()
    server.initProject('Dismiss Test')

    seedTension(server, {
      description: 'False positive between CSP and DeepSeek',
      severity: 'significant',
    })

    const result = server.resolveTension('CSP DeepSeek', 'Unrelated constraints', 'dismiss')
    expect(result.success).toBe(true)

    const model = server.getModel()
    const tension = Array.from(model.tensions.values()).find(t => t.id === result.tensionId)
    expect(tension?.resolution).toBe('Dismissed: Unrelated constraints')

    server.shutdown()
  })

  it('bulkResolveTensions resolves by severity filter', () => {
    const server = new ForgeServer()
    server.initProject('Bulk Test')

    seedTension(server, { description: 'Info tension 1', severity: 'informational' })
    seedTension(server, { description: 'Info tension 2', severity: 'informational' })
    seedTension(server, { description: 'Sig tension 1', severity: 'significant' })

    const result = server.bulkResolveTensions('informational', 'Cleanup')
    expect(result.success).toBe(true)
    expect(result.resolvedCount).toBe(2)

    // Significant tension should still be active
    const model = server.getModel()
    const active = Array.from(model.tensions.values()).filter(t => t.status === 'active')
    expect(active.length).toBe(1)
    expect(active[0].severity).toBe('significant')

    server.shutdown()
  })

  it('bulkResolveTensions with "all" resolves everything', () => {
    const server = new ForgeServer()
    server.initProject('Bulk All Test')

    seedTension(server, { description: 'Tension A', severity: 'informational' })
    seedTension(server, { description: 'Tension B', severity: 'significant' })
    seedTension(server, { description: 'Tension C', severity: 'blocking' })

    const result = server.bulkResolveTensions('all', 'Full cleanup')
    expect(result.success).toBe(true)
    expect(result.resolvedCount).toBe(3)

    const model = server.getModel()
    const active = Array.from(model.tensions.values()).filter(t => t.status === 'active')
    expect(active.length).toBe(0)

    server.shutdown()
  })

  it('bulkResolveTensions returns zero when no matching tensions', () => {
    const server = new ForgeServer()
    server.initProject('Empty Bulk Test')

    const result = server.bulkResolveTensions('all', 'Nothing to do')
    expect(result.success).toBe(true)
    expect(result.resolvedCount).toBe(0)

    server.shutdown()
  })
})
