import { describe, it, expect } from 'vitest'
import { createProvenance, isHighConfidence } from '../provenance'

describe('createProvenance', () => {
  it('creates a valid Provenance with all fields', () => {
    const p = createProvenance('sess_abc', 3, 'Some user turn')

    expect(p.sessionId).toBe('sess_abc')
    expect(p.turnIndex).toBe(3)
    expect(p.rawTurn).toBe('Some user turn')
    expect(p.extractedAt).toBeInstanceOf(Date)
  })

  it('defaults confidence to high', () => {
    const p = createProvenance('sess_abc', 1, 'turn text')
    expect(p.confidence).toBe('high')
  })

  it('accepts explicit confidence', () => {
    const p = createProvenance('sess_abc', 1, 'turn text', 'low')
    expect(p.confidence).toBe('low')
  })
})

describe('isHighConfidence', () => {
  it('returns true for high confidence', () => {
    const p = createProvenance('sess_abc', 1, 'turn', 'high')
    expect(isHighConfidence(p)).toBe(true)
  })

  it('returns false for medium confidence', () => {
    const p = createProvenance('sess_abc', 1, 'turn', 'medium')
    expect(isHighConfidence(p)).toBe(false)
  })

  it('returns false for low confidence', () => {
    const p = createProvenance('sess_abc', 1, 'turn', 'low')
    expect(isHighConfidence(p)).toBe(false)
  })
})
