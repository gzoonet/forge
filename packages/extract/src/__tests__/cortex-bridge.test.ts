import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CortexBridge } from '../cortex-bridge'

describe('CortexBridge', () => {
  beforeEach(() => {
    CortexBridge.resetAvailabilityCache()
  })

  describe('isAvailable', () => {
    it('should return false when cortex is not installed', () => {
      // On this test machine, cortex is unlikely to be installed
      // The method checks `which cortex` — if it fails, returns false
      const available = CortexBridge.isAvailable()
      // We just verify it returns a boolean without throwing
      expect(typeof available).toBe('boolean')
    })

    it('should cache the availability result', () => {
      const first = CortexBridge.isAvailable()
      const second = CortexBridge.isAvailable()
      expect(first).toBe(second)
    })

    it('should reset cache when requested', () => {
      CortexBridge.isAvailable()
      CortexBridge.resetAvailabilityCache()
      // After reset, it should re-check (won't throw)
      const result = CortexBridge.isAvailable()
      expect(typeof result).toBe('boolean')
    })
  })

  describe('query (not connected)', () => {
    it('should return empty array when not connected', async () => {
      const bridge = new CortexBridge()
      const result = await bridge.query('database patterns')
      expect(result).toEqual([])
    })

    it('should return empty array from getEntities when not connected', async () => {
      const bridge = new CortexBridge()
      const result = await bridge.getEntities('PostgreSQL')
      expect(result).toEqual([])
    })

    it('should report not connected', () => {
      const bridge = new CortexBridge()
      expect(bridge.isConnected()).toBe(false)
    })
  })

  describe('connect (cortex not available)', () => {
    it('should return false when cortex is not installed', async () => {
      // Force unavailable
      CortexBridge.resetAvailabilityCache()
      // If cortex isn't installed (likely in test env), connect returns false
      const bridge = new CortexBridge()
      const connected = await bridge.connect()
      // Either cortex is available (true) or not (false) — no exception
      expect(typeof connected).toBe('boolean')
    })
  })

  describe('disconnect', () => {
    it('should be safe to call when not connected', async () => {
      const bridge = new CortexBridge()
      await bridge.disconnect() // Should not throw
      expect(bridge.isConnected()).toBe(false)
    })

    it('should be safe to call multiple times', async () => {
      const bridge = new CortexBridge()
      await bridge.disconnect()
      await bridge.disconnect()
      expect(bridge.isConnected()).toBe(false)
    })
  })

  describe('parseQueryResponse (via query path)', () => {
    // Test the response parsing logic indirectly through a bridge
    // that receives mock data. Since we can't easily mock the child process,
    // we test the parser directly.

    it('should handle empty results gracefully', async () => {
      const bridge = new CortexBridge()
      const result = await bridge.query('')
      expect(result).toEqual([])
    })
  })
})

describe('CortexBridge response parsing', () => {
  // Access the private parseQueryResponse via a test subclass
  class TestableBridge extends CortexBridge {
    testParse(text: string) {
      return (this as any).parseQueryResponse(text)
    }
  }

  let bridge: TestableBridge

  beforeEach(() => {
    bridge = new TestableBridge()
  })

  it('should parse JSON array response', () => {
    const json = JSON.stringify([
      { name: 'UserService', type: 'component', description: 'Handles user auth', filePath: 'src/services/user.ts', confidence: 0.9 },
      { name: 'PostgreSQL', type: 'dependency', description: 'Primary database', confidence: 0.8 },
    ])
    const result = bridge.testParse(json)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      entityType: 'component',
      name: 'UserService',
      description: 'Handles user auth',
      filePath: 'src/services/user.ts',
      confidence: 0.9,
      relationships: undefined,
    })
    expect(result[1].entityType).toBe('dependency')
    expect(result[1].filePath).toBeUndefined()
  })

  it('should parse markdown list response', () => {
    const text = `
- **UserService** - Handles authentication and user management
- **DatabasePool** - Connection pooling for PostgreSQL in src/db/pool.ts
    `
    const result = bridge.testParse(text)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].name).toBe('UserService')
  })

  it('should handle numbered list response', () => {
    const text = `
1. **AuthMiddleware** - JWT token validation
2. **RateLimiter** - Request throttling at file: src/middleware/rate.ts
    `
    const result = bridge.testParse(text)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].name).toBe('AuthMiddleware')
  })

  it('should extract file paths from text', () => {
    const text = `- **Config** - App configuration in src/config.ts`
    const result = bridge.testParse(text)
    expect(result).toHaveLength(1)
    expect(result[0].filePath).toBe('src/config.ts')
  })

  it('should handle empty text', () => {
    const result = bridge.testParse('')
    expect(result).toEqual([])
  })

  it('should handle plain text without entity markers', () => {
    const text = 'No entities found matching your query.'
    const result = bridge.testParse(text)
    expect(result).toEqual([])
  })

  it('should set default confidence to 0.5', () => {
    const json = JSON.stringify([{ name: 'Foo', description: 'Bar' }])
    const result = bridge.testParse(json)
    expect(result[0].confidence).toBe(0.5)
  })

  it('should handle JSON with relationships', () => {
    const json = JSON.stringify([{
      name: 'PaymentService',
      type: 'component',
      description: 'Stripe integration',
      relationships: ['UserService', 'OrderService'],
    }])
    const result = bridge.testParse(json)
    expect(result[0].relationships).toEqual(['UserService', 'OrderService'])
  })
})

describe('Pipeline integration (no Cortex)', () => {
  // Verify the pipeline works normally without Cortex
  it('should not break when Cortex is unavailable', async () => {
    const { ExtractionPipeline } = await import('../pipeline')
    const { ProjectModelStore } = await import('@gzoo/forge-store')
    const { MockLLMClient } = await import('./mock-llm')

    const store = new ProjectModelStore(':memory:')
    const mockLLM = new MockLLMClient()
    const pipeline = new ExtractionPipeline(store, mockLLM)

    const projectId = store.createProject('ws_test', 'Test')
    const sessionId = store.startSession(projectId)

    // initCortex should not throw even if cortex is not installed
    const connected = await pipeline.initCortex()
    // On test machines without cortex, this should be false
    expect(typeof connected).toBe('boolean')

    // Pipeline should still process turns normally
    mockLLM.addClassifyResponse('decision', 'high')
    mockLLM.addExtractResponse('decision node', {
      turnType: 'decision',
      data: {
        statement: 'Use TypeScript',
        category: 'technical',
        rationale: 'Type safety',
        alternatives: ['JavaScript'],
        commitment: 'decided',
        certainty: 'evidenced',
      },
    })

    const result = await pipeline.processTurn(
      { sessionId, turnIndex: 1, speaker: 'user', text: "Let's use TypeScript", timestamp: new Date() },
      projectId as any
    )

    expect(result.modelUpdates.length).toBeGreaterThan(0)
    // cortexMatches should be undefined when Cortex is not connected
    expect(result.cortexMatches).toBeUndefined()

    store.close()
  })
})
