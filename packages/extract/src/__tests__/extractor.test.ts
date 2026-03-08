import { describe, it, expect, vi } from 'vitest'
import { extract } from '../extractor'
import type { LLMClient } from '../llm-client'

function mockLLM(responses: string[]): LLMClient {
  let callIndex = 0
  return {
    complete: vi.fn(async () => {
      const text = responses[callIndex] ?? ''
      callIndex++
      return { text }
    }),
  }
}

describe('extract — JSON retry logic', () => {
  it('succeeds on valid JSON first try', async () => {
    const llm = mockLLM([
      '{"statement":"Use React","rationale":"Team knows it","alternatives":[],"commitment":"decided","certainty":"evidenced","category":"technical"}',
    ])

    const result = await extract('decision', 'We should use React', '', llm)

    expect(result).not.toBeNull()
    expect(result!.turnType).toBe('decision')
    expect(result!.data.statement).toBe('Use React')
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })

  it('retries on malformed JSON and succeeds on second try', async () => {
    const llm = mockLLM([
      'Here is the decision: {invalid json...',
      '{"statement":"Use React","rationale":"Team knows it","alternatives":[],"commitment":"decided","certainty":"evidenced","category":"technical"}',
    ])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await extract('decision', 'We should use React', '', llm)

    expect(result).not.toBeNull()
    expect(result!.data.statement).toBe('Use React')
    expect(llm.complete).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('JSON parse failed'))

    warnSpy.mockRestore()
  })

  it('returns null after both attempts fail', async () => {
    const llm = mockLLM([
      'This is not JSON at all',
      'Still not JSON, sorry!',
    ])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await extract('decision', 'We should use React', '', llm)

    expect(result).toBeNull()
    expect(llm.complete).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry also failed'))

    warnSpy.mockRestore()
  })

  it('handles markdown-fenced JSON on first try', async () => {
    const llm = mockLLM([
      '```json\n{"statement":"Use React","rationale":"Good","alternatives":[],"commitment":"decided","certainty":"evidenced","category":"technical"}\n```',
    ])

    const result = await extract('decision', 'We should use React', '', llm)

    expect(result).not.toBeNull()
    expect(result!.data.statement).toBe('Use React')
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })

  it('returns null for non-extractable turn types', async () => {
    const llm = mockLLM([])
    const result = await extract('question', 'What do you think?', '', llm)
    expect(result).toBeNull()
    expect(llm.complete).not.toHaveBeenCalled()
  })
})
