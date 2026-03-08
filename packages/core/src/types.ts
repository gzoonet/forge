import type { NodeId, ModelNodeType } from './ids'

// ─── Primitives ──────────────────────────────────────────────────────────────

export type Provenance = {
  sessionId: string
  turnIndex: number
  extractedAt: Date
  confidence: 'high' | 'medium' | 'low'
  rawTurn: string
}

export type CommitmentLevel = 'exploring' | 'leaning' | 'decided' | 'locked'
export type CertaintyLevel = 'assumed' | 'uncertain' | 'evidenced' | 'validated'
export type RejectionType = 'categorical' | 'conditional' | 'deferred'

export type DecisionCategory =
  | 'market'
  | 'product'
  | 'technical'
  | 'business'
  | 'operational'
  | 'brand'

export type ConstraintType =
  | 'technical'
  | 'financial'
  | 'market'
  | 'timeline'
  | 'operational'
  | 'aesthetic'
  | 'ethical'
  | 'regulatory'
  | 'strategic'

export type ConstraintSource =
  | 'stated'
  | 'revealed'
  | 'inherited'
  | 'workspace'
  | 'external'

// ─── Turn Classification ─────────────────────────────────────────────────────

export type TurnType =
  | 'goal_statement'
  | 'decision'
  | 'constraint_stated'
  | 'rejection'
  | 'exploration'
  | 'approval'
  | 'correction'
  | 'question'
  | 'elaboration'
  | 'meta'

export type TurnClassification = {
  type: TurnType
  confidence: 'high' | 'medium' | 'low'
  additionalTypes?: TurnType[]
}

// ─── Promotion ───────────────────────────────────────────────────────────────

export type PromotionTrigger =
  // exploring → leaning (automatic)
  | 'comparative_preference'
  | 'return_without_question'
  | 'implicit_assumption'
  // leaning → decided (NEVER automatic)
  | 'explicit_commitment'
  | 'artifact_approval'
  // decided → locked (automatic on structural facts)
  | 'dependency_threshold'
  | 'artifact_committed'

export type CommitmentPromotion = {
  from: CommitmentLevel
  to: CommitmentLevel
  trigger: PromotionTrigger
  wasAutomatic: boolean
  sessionId: string
  turnIndex: number
  promotedAt: Date
}

// ─── Model Nodes ─────────────────────────────────────────────────────────────

export type ClosedOption = {
  description: string
  reversalCost: 'low' | 'medium' | 'high' | 'extreme'
  affectedDecisionIds: NodeId[]
  detectedAt: Date
}

export type Decision = {
  id: NodeId
  category: DecisionCategory
  statement: string
  rationale: string
  alternatives: string[]
  commitment: CommitmentLevel
  certainty: CertaintyLevel
  provenance: Provenance
  promotionHistory: CommitmentPromotion[]
  constrains: NodeId[]
  dependsOn: NodeId[]
  enables: NodeId[]
  manifestsIn: NodeId[]
  closedOptions: ClosedOption[]
}

export type ConstraintPropagation = {
  affectedNodeId: NodeId
  affectedNodeType: 'decision' | 'exploration' | 'artifact' | 'option'
  impact: string
  severity: 'informational' | 'limiting' | 'blocking'
}

export type Constraint = {
  id: NodeId
  type: ConstraintType
  statement: string
  source: ConstraintSource
  hardness: 'hard' | 'soft'
  certainty: CertaintyLevel
  provenance: Provenance
  originDecisionId?: NodeId
  originStatementTurn?: number
  propagatesTo: ConstraintPropagation[]
  isRevealed: boolean
  revealedEvidence?: string[]
  conflictId?: NodeId
  conflictScore?: ConstraintScore
  scope: 'workspace' | 'project'
}

export type Rejection = {
  id: NodeId
  category: DecisionCategory
  statement: string
  rejectionType: RejectionType
  reason: string
  provenance: Provenance
  revivalCondition?: string
  revivalTriggerId?: NodeId
  revealsPreference?: string
  contributesToValues: boolean
}

export type Exploration = {
  id: NodeId
  topic: string
  direction: string
  openQuestions: string[]
  consideredOptions: string[]
  provenance: Provenance
  resolutionCondition?: string
  status: 'active' | 'resolved' | 'abandoned' | 'deferred'
  resolvedToDecisionId?: NodeId
  resolvedAt?: Date
}

export type Tension = {
  id: NodeId
  description: string
  nodeAId: NodeId
  nodeBId: NodeId
  nodeAType: ModelNodeType
  nodeBType: ModelNodeType
  severity: 'informational' | 'significant' | 'blocking'
  detectedAt: Date
  provenance: Provenance
  status: 'active' | 'acknowledged' | 'resolved'
  resolution?: string
  resolvedAt?: Date
  resolvedBy?: Provenance
}

// ─── Constraint Conflict ─────────────────────────────────────────────────────

export type ConstraintScore = {
  total: number
  recency: number
  frequency: number
  consistency: number
  stakes: number
}

export type ConstraintConflict = {
  id: NodeId
  statedConstraintId: NodeId
  revealedConstraintId: NodeId
  statedScore: ConstraintScore
  revealedScore: ConstraintScore
  winner: 'stated' | 'revealed' | 'unresolved'
  surfacedAt: Date
  resolvedAt?: Date
  userResolution?: string
}

// ─── Artifact Layer ──────────────────────────────────────────────────────────

export type ArtifactType =
  | 'spec'
  | 'flow'
  | 'data_model'
  | 'api_contract'
  | 'code_scaffold'
  | 'config'
  | 'copy'
  | 'architecture'

export type ArtifactStatus =
  | 'draft'
  | 'ready'
  | 'approved'
  | 'committed'
  | 'superseded'
  | 'rejected'

export type ArtifactContent = {
  format: 'markdown' | 'json' | 'typescript' | 'yaml' | 'diagram' | 'plaintext'
  body: string
  metadata?: Record<string, unknown>
}

export type ArtifactSection = {
  id: NodeId
  artifactId: NodeId
  parentSectionId?: NodeId
  childSectionIds: NodeId[]
  title: string
  content: ArtifactContent
  status: ArtifactStatus
  version: number
  previousVersionId?: NodeId
  committedAt?: Date
  committedBy?: string
  sourceDecisionIds: NodeId[]
  sourceConstraintIds: NodeId[]
  provenance: Provenance
}

export type Artifact = {
  id: NodeId
  type: ArtifactType
  name: string
  description: string
  status: ArtifactStatus
  provenance: Provenance
  sourceDecisionIds: NodeId[]
  sourceConstraintIds: NodeId[]
  sections: Map<NodeId, ArtifactSection>
  rootSectionId: NodeId
  version: string
  fullyCommitted: boolean
  committedAt?: Date
}

// ─── Intent Layer ────────────────────────────────────────────────────────────

export type ScopeItem = {
  description: string
  rationale?: string
  provenance: Provenance
  commitment: CommitmentLevel
}

export type IntentLayer = {
  primaryGoal: {
    statement: string
    successCriteria: string[]
    provenance: Provenance
    commitment: CommitmentLevel
  } | null
  scope: {
    inScope: ScopeItem[]
    outOfScope: ScopeItem[]
    unknownScope: string[]
  }
  qualityBar: {
    statement: string
    tradeoffs: string[]
    provenance: Provenance
  } | null
  successMetrics: { metric: string; target?: string; provenance: Provenance }[]
  antiGoals: { statement: string; reason: string; provenance: Provenance }[]
}

// ─── Project Model ───────────────────────────────────────────────────────────

export type ProjectModel = {
  id: NodeId
  workspaceId: string
  name: string
  createdAt: Date
  updatedAt: Date
  version: number
  sessionIds: string[]
  intent: IntentLayer
  decisions: Map<NodeId, Decision>
  constraints: Map<NodeId, Constraint>
  rejections: Map<NodeId, Rejection>
  explorations: Map<NodeId, Exploration>
  tensions: Map<NodeId, Tension>
  artifacts: Map<NodeId, Artifact>
  inheritedGlobalConstraintIds: NodeId[]
}

// ─── Execution State ─────────────────────────────────────────────────────────

export type ExecutionAction = {
  id: NodeId
  description: string
  service: string
  actionType: string
  parameters: Record<string, unknown>
  status: 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'rolled_back'
  sourceDecisionId?: NodeId
  sourceArtifactId?: NodeId
  sourceArtifactSectionId?: NodeId
  requiresApproval: boolean
  approvedAt?: Date
  approvedBy?: string
  result?: Record<string, unknown>
  error?: string
  completedAt?: Date
  isReversible: boolean
  rollbackActionId?: NodeId
}

export type ExecutionState = {
  pendingActions: ExecutionAction[]
  completedActions: ExecutionAction[]
  failedActions: ExecutionAction[]
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type SessionBoundaryReason =
  | 'time_gap'
  | 'explicit_close'
  | 'project_shift'
  | 'milestone_reached'
  | 'workspace_init'

export type ConversationalTurn = {
  sessionId: string
  turnIndex: number
  speaker: 'user' | 'system'
  text: string
  timestamp: Date
}

export type ModelChange = {
  nodeId: NodeId
  nodeType: ModelNodeType
  changeType: 'created' | 'updated' | 'promoted' | 'resolved' | 'rejected'
  previousValue?: unknown
  newValue: unknown
  turnIndex: number
}

export type Escalation = {
  id: string
  triggeredAt: Date
  turnIndex: number
  reason: string
  constraintPropagations: ConstraintPropagation[]
  affectedNodeIds: NodeId[]
  wasAcknowledged: boolean
  userResponse?: string
}

// ─── Extraction Result ───────────────────────────────────────────────────────

export type ModelUpdate = {
  operation: 'insert' | 'update' | 'promote' | 'link'
  targetLayer:
    | 'intent'
    | 'decisions'
    | 'constraints'
    | 'rejections'
    | 'explorations'
    | 'tensions'
    | 'artifacts'
    | 'artifact_sections'
  nodeId: NodeId
  changes: Record<string, unknown>
}

export type PromotionCheck = {
  nodeId: NodeId
  currentCommitment: CommitmentLevel
  candidatePromotion: CommitmentLevel
  trigger: PromotionTrigger
  isAutomatic: boolean
  requiresUserAction: boolean
}

export type ExtractionResult = {
  turnRef: { sessionId: string; turnIndex: number }
  classifications: TurnClassification[]
  modelUpdates: ModelUpdate[]
  promotionChecks: PromotionCheck[]
  constraintChecksTriggered: boolean
  conflictChecksTriggered: boolean
  escalationRequired: boolean
  escalationReason?: string
  surfacingDecisions?: SurfacingDecision[]
  memoryMatches?: MemoryMatch[]
  extractionFailures?: number
}

// ─── Session Brief ───────────────────────────────────────────────────────────

export type BriefDecision = {
  statement: string
  commitment: CommitmentLevel
  category: DecisionCategory
}

export type BriefExploration = {
  topic: string
  openQuestions: string[]
}

export type BriefTension = {
  description: string
  severity: 'informational' | 'significant' | 'blocking'
}

export type BriefArtifact = {
  name: string
  type: ArtifactType
  status: ArtifactStatus
  sectionsInProgress: number
  sectionsCommitted: number
}

export type SessionBrief = {
  generatedAt: Date
  projectName: string
  primaryGoal: string
  lockedDecisions: BriefDecision[]
  decidedDecisions: BriefDecision[]
  pendingDecisions: BriefExploration[]
  unresolvedTensions: BriefTension[]
  changesSinceLastSession: string[]
  lastSessionGoal: string
  lastSessionOutcome: string
  artifactsInProgress: BriefArtifact[]
  recentlyCommitted: BriefArtifact[]
}

// ─── Session Model ───────────────────────────────────────────────────────────

export type Session = {
  id: string
  projectId: NodeId
  workspaceId: string
  startedAt: Date
  endedAt?: Date
  openingBrief: SessionBrief
  modelChanges: ModelChange[]
  extractedNodes: {
    decisions: NodeId[]
    constraints: NodeId[]
    rejections: NodeId[]
    explorations: NodeId[]
    tensions: NodeId[]
    artifacts: NodeId[]
    artifactSections: NodeId[]
  }
  escalations: Escalation[]
  sessionGoal?: string
}

// ─── Trust Calibration ──────────────────────────────────────────────────────

export type SurfacingType =
  | 'promotion_suggestion'     // Leaning → decided prompt
  | 'constraint_conflict'      // Stated vs revealed conflict
  | 'escalation'              // Constraint propagation escalation
  | 'scope_drift'             // Scope creep detection
  | 'tension_detected'        // New tension surfaced
  | 'locked_notification'     // Decision locked notification
  | 'artifact_ready'          // Artifact ready for review
  | 'session_brief'           // Session brief on return

export type SurfacingEvent = {
  id: string
  type: SurfacingType
  sessionId: string
  turnIndex: number
  surfacedAt: Date
  targetNodeIds: NodeId[]        // What nodes this surfacing is about
  message: string                // The message shown to the user
  wasAcknowledged: boolean       // Did the user respond?
  userResponse?: string          // What did they say?
  wasHelpful?: boolean           // Post-hoc: did this help or annoy?
}

export type FlowState = {
  isInFlow: boolean
  consecutiveProductiveTurns: number  // Turns with decisions/progress, no confusion
  lastInterruptionTurn: number        // When we last interrupted
  turnsSinceInterruption: number      // How many turns since last interruption
  sessionStartTurn: number
}

export type InterruptionBudget = {
  maxInterruptionsPerSession: number   // Default: 5
  interruptionsUsed: number
  remainingBudget: number
  cooldownTurns: number                // Min turns between interruptions (default: 3)
}

export type TrustMetrics = {
  sessionId: string
  totalSurfacings: number
  acknowledgedSurfacings: number
  ignoredSurfacings: number
  correctionsThisSession: number       // Corrections = extraction quality signal
  falseEscalations: number             // Escalations user dismissed
  helpfulSurfacings: number            // Surfacings user acted on
  flowInterruptions: number            // Times we broke flow
  suppressedSurfacings: number         // Things we chose NOT to surface
}

export type SurfacingDecision = {
  shouldSurface: boolean
  reason: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  type?: SurfacingType                  // What kind of surfacing this is
  targetNodeIds?: NodeId[]              // Which nodes this is about
  suggestedMessage?: string
  suppressedBecause?: string           // If not surfacing, why
}

// ─── Workspace ───────────────────────────────────────────────────────────────

export type InferredPreference = {
  statement: string
  confidence: 'low' | 'medium' | 'high'
  evidenceCount: number
  sourceRejectionIds: NodeId[]
  sourceDecisionIds: NodeId[]
  sourceProjectIds: NodeId[]
}

export type ValuesModel = {
  inferredPreferences: InferredPreference[]
  statedPrinciples: string[]
  updatedAt: Date
}

export type RiskProfile = {
  technical: 'conservative' | 'moderate' | 'aggressive'
  market: 'conservative' | 'moderate' | 'aggressive'
  financial: 'conservative' | 'moderate' | 'aggressive'
}

export type Integration = {
  id: string
  service: string
  config: Record<string, unknown>
  enabledAt: Date
}

export type Workspace = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  valuesModel: ValuesModel
  riskProfile: RiskProfile
  globalConstraints: Map<NodeId, Constraint>
  integrations: Integration[]
  projectIds: NodeId[]
  activeProjectId?: NodeId
  cortexConfig?: {
    enabled: boolean
    cortexProjectPaths: string[]
    lastSyncedAt?: Date
  }
}

// ─── Historical Memory (Cortex Integration) ────────────────────────────────

export type MemoryMatch = {
  projectId: NodeId
  projectName: string
  nodeType: 'decision' | 'rejection' | 'constraint' | 'exploration'
  statement: string
  category?: string
  outcome?: string                     // What happened after this decision
  relevanceScore: number               // 0-100, how relevant to current context
  matchReason: string                  // Why this was surfaced
}

export type MemoryQuery = {
  currentDecision?: string             // Decision being made now
  currentExploration?: string          // Exploration being considered
  categories?: string[]                // Filter by decision categories
  excludeProjectId?: NodeId            // Don't include current project
}

export type MemoryResult = {
  matches: MemoryMatch[]
  queryTime: number                    // ms
  source: 'local' | 'cortex'          // Where the memory came from
}
