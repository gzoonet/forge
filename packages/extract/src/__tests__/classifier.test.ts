import { describe, it, expect, beforeEach } from 'vitest'
import { classify } from '../classifier'
import { MockLLMClient } from './mock-llm'

let mockLLM: MockLLMClient

beforeEach(() => {
  mockLLM = new MockLLMClient()
})

describe('Stage 1 — Classifier', () => {
  it('classifies a clear decision', async () => {
    mockLLM.addClassifyResponse('decision', 'high')

    const result = await classify("Let's use Postgres.", '', mockLLM)
    expect(result.primary).toBe('decision')
    expect(result.confidence).toBe('high')
  })

  it('classifies an exploration', async () => {
    mockLLM.addClassifyResponse('exploration', 'high')

    const result = await classify(
      "I'm thinking maybe we use Postgres. Or maybe SQLite. What do you think?",
      '',
      mockLLM
    )
    expect(result.primary).toBe('exploration')
  })

  it('handles multiple types in one turn', async () => {
    mockLLM.addClassifyResponse('decision', 'high', ['exploration'])

    const result = await classify(
      "We definitely need authentication. JWT is probably the right call, but I want to think about Clerk.",
      '',
      mockLLM
    )
    expect(result.primary).toBe('decision')
    expect(result.additional).toContain('exploration')
  })

  it('defaults to exploration on invalid response', async () => {
    mockLLM.addResponse(() => true, 'not valid json at all')

    const result = await classify('some turn', '', mockLLM)
    expect(result.primary).toBe('exploration')
    expect(result.confidence).toBe('low')
  })

  it('defaults to exploration on invalid turn type', async () => {
    mockLLM.addResponse(
      (req) => req.system.includes('turn classifier'),
      JSON.stringify({ primary: 'invalid_type', confidence: 'high' })
    )

    const result = await classify('some turn', '', mockLLM)
    expect(result.primary).toBe('exploration')
  })

  it('strips markdown fences from response', async () => {
    mockLLM.addResponse(
      (req) => req.system.includes('turn classifier'),
      '```json\n{"primary": "decision", "confidence": "high"}\n```'
    )

    const result = await classify("Let's go with React.", '', mockLLM)
    expect(result.primary).toBe('decision')
  })

  it('passes recent context to the prompt', async () => {
    mockLLM.addClassifyResponse('elaboration', 'medium')

    await classify('Add pagination too', 'user: We need a user list', mockLLM)

    expect(mockLLM.calls[0].prompt).toContain('Recent conversation context:')
    expect(mockLLM.calls[0].prompt).toContain('user: We need a user list')
  })
})
