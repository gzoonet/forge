import type {
  NodeId,
  ModelNodeType,
  Provenance,
  CommitmentLevel,
  PromotionTrigger,
  SessionBoundaryReason,
  Tension,
  Escalation,
  TurnClassification,
  ExtractionResult,
} from '@gzoo/forge-core'

// ─── Event Types ─────────────────────────────────────────────────────────────

export type ForgeEvent =
  | { type: 'PROJECT_CREATED'; projectId: NodeId; workspaceId: string; name: string }
  | { type: 'SESSION_STARTED'; sessionId: string; projectId: NodeId }
  | { type: 'SESSION_ENDED'; sessionId: string; reason: SessionBoundaryReason }
  | { type: 'INTENT_UPDATED'; projectId: NodeId; field: string; value: unknown; provenance: Provenance }
  | { type: 'NODE_CREATED'; nodeType: ModelNodeType; node: unknown; provenance: Provenance }
  | { type: 'NODE_UPDATED'; nodeId: NodeId; nodeType: ModelNodeType; changes: Record<string, unknown>; provenance: Provenance }
  | { type: 'NODE_PROMOTED'; nodeId: NodeId; from: CommitmentLevel; to: CommitmentLevel; trigger: PromotionTrigger; wasAutomatic: boolean; provenance: Provenance }
  | { type: 'NODE_REJECTED'; nodeId: NodeId; nodeType: ModelNodeType; reason: string; provenance: Provenance }
  | { type: 'TENSION_DETECTED'; tension: Tension }
  | { type: 'TENSION_RESOLVED'; tensionId: NodeId; resolution: string; provenance: Provenance }
  | { type: 'ESCALATION_TRIGGERED'; escalation: Escalation }
  | { type: 'CORRECTION_APPLIED'; targetNodeId: NodeId; changes: Record<string, unknown>; provenance: Provenance }

export type StoredEvent = {
  eventId: string
  projectId: NodeId
  sessionId: string
  turnIndex: number
  storedAt: Date
} & ForgeEvent

// ─── Stored Turn ─────────────────────────────────────────────────────────────

export type StoredTurn = {
  turnId: string
  sessionId: string
  projectId: NodeId
  turnIndex: number
  speaker: 'user' | 'system'
  text: string
  timestamp: Date
  classification?: TurnClassification[]
  extractionResult?: ExtractionResult
}
