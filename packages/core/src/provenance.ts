import type { Provenance } from './types'

export function createProvenance(
  sessionId: string,
  turnIndex: number,
  rawTurn: string,
  confidence: Provenance['confidence'] = 'high'
): Provenance {
  return {
    sessionId,
    turnIndex,
    extractedAt: new Date(),
    confidence,
    rawTurn,
  }
}

export function isHighConfidence(provenance: Provenance): boolean {
  return provenance.confidence === 'high'
}
