import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ForgeServer } from '../server'
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
