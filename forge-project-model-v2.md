# GZOO Forge — Project Model Schema
### Phase 0 Design Document — v0.2

---

## Design Principles

Before the types, the principles that govern every decision in this schema:

1. **Every field must earn its place.** If it can't be extracted from conversation and it doesn't drive a downstream behavior, it doesn't exist in the model.

2. **Provenance is non-negotiable.** Every node in this model must know where it came from — which conversation turn, which session, which prior decision. Without provenance, the model is a black box and trust dies.

3. **Rejection is first-class.** Most systems throw away what was ruled out. This schema treats rejections as structural data. A rejection with a reason is a window into judgment. A conditional rejection is a deferred decision. Both matter.

4. **Constraints are relationships, not attributes.** A constraint doesn't just exist — it points at things. It connects a decision to the future options it affects. The schema must make this traversable.

5. **Certainty and commitment are separate axes.** You can be certain about something you haven't committed to. You can commit to something you're uncertain about. These are different states and the schema treats them differently.

6. **The workspace owns the person. The project owns the work.** Multi-project constraints, the values model, and shared integrations live at workspace level. They inform projects but don't belong to them.

7. **Commitment promotion is signal-driven, not time-driven.** The system can promote automatically up to `leaning`. Only the user can promote to `decided`. `locked` is structural reality, not a choice.

---

## Schema Hierarchy

```
Workspace                          ← Person-level. Owns values, multi-project constraints,
│                                    shared integrations, Cortex connection.
├── Project A                      ← Work-level. Owns intent, decisions, constraints,
│   ├── Session 1                    rejections, explorations, tensions, artifacts,
│   ├── Session 2                    execution state.
│   └── Session N
├── Project B
└── Project N
```

---

## Core Primitives

These types underpin everything else.

```typescript
// Every node in the model is traceable to its origin
type Provenance = {
  sessionId: string
  turnIndex: number          // Which conversational turn produced this
  extractedAt: Date
  confidence: 'high' | 'medium' | 'low'  // Extraction confidence, not user confidence
  rawTurn: string            // The exact text that produced this node
}

// How committed is the user to this node?
// PROMOTION RULES — see Commitment Promotion section below
type CommitmentLevel =
  | 'exploring'    // Thinking out loud. Not a decision. Don't lock this.
  | 'leaning'      // Directional preference expressed. Still reversible easily.
  | 'decided'      // Explicit commitment. Requires deliberate action to reverse.
  | 'locked'       // Committed AND artifacts/dependencies exist. Reversal is expensive.

// What kind of certainty does the user have?
type CertaintyLevel =
  | 'assumed'      // Hasn't been questioned, just taken as given
  | 'uncertain'    // User expressed doubt or hedging
  | 'evidenced'    // User cited a reason, past experience, or data
  | 'validated'    // Has been tested or confirmed in some way

// How permanent is a rejection?
type RejectionType =
  | 'categorical'   // "That's wrong." Permanent. Informs values model.
  | 'conditional'   // "Not now because X." Becomes viable if X changes.
  | 'deferred'      // "Maybe later." Low signal, low priority, keep quietly.

// Unique identifier type for clarity
type NodeId = string  // nanoid, prefixed by type e.g. "dec_abc123", "con_xyz789"

type ModelNodeType =
  | 'intent'
  | 'decision'
  | 'constraint'
  | 'rejection'
  | 'exploration'
  | 'tension'
  | 'artifact'
  | 'artifact_section'
```

---

## Commitment Promotion Rules

**The single most important behavioral contract in the system.**
These rules determine when nodes advance in commitment level.
Getting this wrong creates model drift and destroys trust.

```typescript
type PromotionRule = {
  from: CommitmentLevel
  to: CommitmentLevel
  trigger: PromotionTrigger
  isAutomatic: boolean       // Can the system do this without user action?
}

type PromotionTrigger =
  // exploring → leaning (AUTOMATIC — system can promote)
  | 'comparative_preference'    // User positions X over Y: "X seems better than Y"
  | 'return_without_question'   // User builds on idea without reconsidering it across turns
  | 'implicit_assumption'       // User treats something as settled in downstream thinking

  // leaning → decided (REQUIRES USER ACTION — never automatic)
  | 'explicit_commitment'       // "Let's go with X" / "We're doing X" / "X is the call"
  | 'artifact_approval'         // User approves an artifact that encodes this decision

  // decided → locked (AUTOMATIC — based on structural facts, not language)
  | 'dependency_threshold'      // 3+ other decisions list this as a dependency
  | 'artifact_committed'        // An artifact encoding this decision is committed to a real system
```

**The cardinal rule:**
- System promotes `exploring → leaning` automatically when signals are present
- System NEVER promotes `leaning → decided` — the user must close this door
- System promotes `decided → locked` automatically when structural facts are met
- System always notifies the user when a node is promoted to `locked`

**Why `leaning → decided` requires user action:**
Implicit promotion to `decided` is the primary mechanism by which the model drifts
away from actual intent. If the system decides you've decided, it starts generating
artifacts and closing constraint branches. The user may not realize this has happened
until significant work has been done in the wrong direction. This is the core trust
violation. Never do it.

---

## Constraint Conflict Resolution

When a stated constraint and a revealed constraint conflict, the system
scores both and surfaces the conflict rather than silently choosing.

```typescript
type ConstraintConflict = {
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

type ConstraintScore = {
  total: number              // Weighted sum, 0–100
  recency: number            // 0–100: How recently evidenced? Last turn > last session > last month
  frequency: number          // 0–100: How many times has this appeared?
  consistency: number        // 0–100: Has it ever been contradicted? Violations reduce score.
  stakes: number             // 0–100: How much does this constrain downstream decisions?

  // Weights
  // recency:     0.25
  // frequency:   0.35
  // consistency: 0.25
  // stakes:      0.15
}

// Scoring logic (for reference — lives in constraint engine, not schema)
// total = (recency * 0.25) + (frequency * 0.35) + (consistency * 0.25) + (stakes * 0.15)
//
// Revealed constraints tend to win on frequency and consistency.
// Stated constraints tend to win on recency and stakes.
// When scores are within 15 points of each other — always surface, never auto-resolve.
// When delta > 15 — the higher score wins, but conflict is still logged.
//
// The surfaced message:
// "You've said [stated constraint] but your choices consistently show [revealed constraint].
//  Which is actually the constraint here?"
```

---

## Workspace Model

Sits above all projects. Owns what belongs to the person, not the project.

```typescript
type Workspace = {
  id: string                           // "ws_..."
  name: string
  createdAt: Date
  updatedAt: Date

  // Person-level knowledge
  valuesModel: ValuesModel             // Moves here from ProjectModel
  riskProfile: RiskProfile             // Inferred across all projects

  // Multi-project constraints — constraints that apply across projects
  globalConstraints: Map<NodeId, Constraint>  // e.g. "always use Anthropic for LLM"

  // Shared integrations — available to all projects
  integrations: Integration[]

  // Project registry
  projectIds: NodeId[]
  activeProjectId?: NodeId

  // Cortex connection
  cortexConfig?: {
    enabled: boolean
    cortexProjectPaths: string[]       // Which Cortex-watched paths feed this workspace
    lastSyncedAt?: Date
  }
}
```

---

## The Project Model

The root object for a single project. Persists and evolves across all sessions.
`valuesModel` has moved to Workspace. Projects inherit global constraints.

```typescript
type ProjectModel = {
  id: NodeId                     // "proj_..."
  workspaceId: string
  name: string
  createdAt: Date
  updatedAt: Date
  version: number                // Increments on every meaningful change
  sessionIds: string[]           // Ordered list of all sessions that touched this model

  intent: IntentLayer
  decisions: Map<NodeId, Decision>
  constraints: Map<NodeId, Constraint>
  rejections: Map<NodeId, Rejection>
  explorations: Map<NodeId, Exploration>
  tensions: Map<NodeId, Tension>
  artifacts: Map<NodeId, Artifact>
  execution: ExecutionState

  // Inherited from workspace — read-only at project level
  inheritedGlobalConstraintIds: NodeId[]
}
```

---

## Intent Layer

What this project is actually trying to achieve. Updated as understanding deepens.

```typescript
type IntentLayer = {
  primaryGoal: {
    statement: string            // "Build a dispatch SaaS for HVAC companies"
    successCriteria: string[]    // What does done look like?
    provenance: Provenance
    commitment: CommitmentLevel
  }

  scope: {
    inScope: ScopeItem[]
    outOfScope: ScopeItem[]      // Explicit exclusions are as important as inclusions
    unknownScope: string[]       // Things that haven't been scoped yet but need to be
  }

  qualityBar: {
    statement: string            // "Good enough to demo to investors" vs "production-grade"
    tradeoffs: string[]          // "Speed over completeness" / "Quality over features"
    provenance: Provenance
  }

  successMetrics: {
    metric: string
    target?: string
    provenance: Provenance
  }[]

  antiGoals: {                   // What this project explicitly is NOT trying to do
    statement: string
    reason: string
    provenance: Provenance
  }[]
}

type ScopeItem = {
  description: string
  rationale?: string
  provenance: Provenance
  commitment: CommitmentLevel
}
```

---

## Decision Layer

The most important layer. Every committed direction lives here.

```typescript
type Decision = {
  id: NodeId                     // "dec_..."
  category: DecisionCategory
  statement: string              // "We will use PostgreSQL for the main database"
  rationale: string              // Why this was decided
  alternatives: string[]        // What else was considered before deciding this
  commitment: CommitmentLevel
  certainty: CertaintyLevel
  provenance: Provenance

  // Promotion history — full audit trail of how commitment evolved
  promotionHistory: CommitmentPromotion[]

  // Constraint relationships — what this decision affects
  constrains: NodeId[]           // IDs of Constraints this decision creates
  dependsOn: NodeId[]            // IDs of other Decisions this relies on
  enables: NodeId[]              // IDs of future Decisions this unlocks

  // Artifact relationships
  manifestsIn: NodeId[]          // IDs of Artifacts that reflect this decision

  // The door-closing question — populated by constraint propagation engine
  closedOptions: ClosedOption[]
}

type CommitmentPromotion = {
  from: CommitmentLevel
  to: CommitmentLevel
  trigger: PromotionTrigger
  wasAutomatic: boolean
  sessionId: string
  turnIndex: number
  promotedAt: Date
}

type DecisionCategory =
  | 'market'          // Who is this for, what problem, what positioning
  | 'product'         // What it does, core features, UX direction
  | 'technical'       // Architecture, stack, data model, infrastructure
  | 'business'        // Pricing, model, go-to-market, revenue
  | 'operational'     // Team, process, tooling, workflow
  | 'brand'           // Name, voice, aesthetic, identity

type ClosedOption = {
  description: string            // "Switching to MongoDB later would require..."
  reversalCost: 'low' | 'medium' | 'high' | 'extreme'
  affectedDecisionIds: NodeId[]
  detectedAt: Date
}
```

---

## Constraint Layer

Constraints are **relationships**, not just facts. They connect decisions to the option space they affect.
Conflict resolution between stated and revealed constraints uses the scoring system above.

```typescript
type Constraint = {
  id: NodeId                     // "con_..."
  type: ConstraintType
  statement: string              // "Must work on mobile"
  source: ConstraintSource
  hardness: 'hard' | 'soft'     // Hard = non-negotiable. Soft = strong preference.
  certainty: CertaintyLevel
  provenance: Provenance

  // What produced this constraint
  originDecisionId?: NodeId      // If this constraint was created by a decision
  originStatementTurn?: number   // If the user stated this directly

  // What this constraint affects — this is the core of the constraint graph
  propagatesTo: ConstraintPropagation[]

  // Stated vs revealed — did the user say this or did we infer it from behavior?
  isRevealed: boolean
  revealedEvidence?: string[]    // If inferred, what behavior revealed it

  // Conflict tracking — if this constraint conflicts with another
  conflictId?: NodeId            // ID of ConstraintConflict if one exists
  conflictScore?: ConstraintScore

  // Scope — does this constraint belong to workspace or project?
  scope: 'workspace' | 'project'
}

type ConstraintType =
  | 'technical'       // "Must use Node.js" / "No more than 3 external services"
  | 'financial'       // "Under $500/mo infrastructure cost"
  | 'market'          // "Enterprise buyers only" / "SMB motion"
  | 'timeline'        // "Must launch in 6 weeks"
  | 'operational'     // "No team to manage" / "Solo maintainable"
  | 'aesthetic'       // "Minimal UI" / "Developer-first experience"
  | 'ethical'         // "No dark patterns" / "Privacy-first"
  | 'regulatory'      // "HIPAA compliant" / "GDPR"
  | 'strategic'       // "Must not compete with existing clients"

type ConstraintSource =
  | 'stated'          // User said it explicitly
  | 'revealed'        // We inferred it from consistent behavior/choices
  | 'inherited'       // Propagated from another decision or constraint
  | 'workspace'       // Inherited from a workspace-level global constraint
  | 'external'        // From context (market, legal, technical reality)

type ConstraintPropagation = {
  affectedNodeId: NodeId         // What decision/option this constraint touches
  affectedNodeType: 'decision' | 'exploration' | 'artifact' | 'option'
  impact: string                 // "This constraint means X cannot do Y"
  severity: 'informational' | 'limiting' | 'blocking'
}
```

---

## Rejection Layer

What was ruled out. First-class data.

```typescript
type Rejection = {
  id: NodeId                     // "rej_..."
  category: DecisionCategory
  statement: string              // "We will NOT use a microservices architecture"
  rejectionType: RejectionType
  reason: string                 // Why was this rejected?
  provenance: Provenance

  // For conditional rejections — what would make this viable?
  revivalCondition?: string      // "Would reconsider if team grows beyond 5 engineers"
  revivalTriggerId?: NodeId      // Link to a constraint or decision that might change

  // What does this rejection reveal about values/judgment?
  revealsPreference?: string     // "Prefers simplicity over scale optionality"

  // Informs the workspace values model
  contributesToValues: boolean
}
```

---

## Exploration Layer

Things that were thought about but not decided.
Holds productive ambiguity open. Does not pressure the user toward resolution.

```typescript
type Exploration = {
  id: NodeId                     // "exp_..."
  topic: string                  // "Thinking about whether to offer a free tier"
  direction: string              // General direction of thinking
  openQuestions: string[]        // What needs to be resolved
  consideredOptions: string[]    // Options that have been surfaced
  provenance: Provenance

  // What would resolve this?
  resolutionCondition?: string   // "Will decide after talking to 3 potential customers"

  // Lifecycle
  status: 'active' | 'resolved' | 'abandoned' | 'deferred'
  resolvedToDecisionId?: NodeId  // If resolved, what decision did it become?
  resolvedAt?: Date
}
```

---

## Tension Layer

When two things in the model conflict.
Surfaces contradictions before they become architectural problems.

```typescript
type Tension = {
  id: NodeId                     // "ten_..."
  description: string            // "Tension between speed-to-market goal and quality bar"
  nodeAId: NodeId                // First conflicting node
  nodeBId: NodeId                // Second conflicting node
  nodeAType: ModelNodeType
  nodeBType: ModelNodeType
  severity: 'informational' | 'significant' | 'blocking'
  detectedAt: Date
  provenance: Provenance

  // How was it resolved?
  status: 'active' | 'acknowledged' | 'resolved'
  resolution?: string
  resolvedAt?: Date
  resolvedBy?: Provenance
}
```

---

## Artifact Layer

Granular versioning. Every artifact is a tree of independently-versioned sections.
Sections can be approved or rejected independently.
Committed sections lock. Uncommitted sections keep evolving.

```typescript
type Artifact = {
  id: NodeId                     // "art_..."
  type: ArtifactType
  name: string
  description: string
  status: ArtifactStatus
  provenance: Provenance

  // What produced this artifact
  sourceDecisionIds: NodeId[]    // Which decisions this artifact reflects
  sourceConstraintIds: NodeId[]  // Which constraints shaped this artifact

  // Section tree — the granular versioning structure
  sections: Map<NodeId, ArtifactSection>
  rootSectionId: NodeId          // The top-level section

  // Composite version — derived from section versions
  // Format: major.minor where major = committed section changes, minor = draft changes
  version: string                // e.g. "2.4"

  // Top-level commit state — only true when ALL sections are committed
  fullyCommitted: boolean
  committedAt?: Date
}

type ArtifactSection = {
  id: NodeId                     // "sec_..."
  artifactId: NodeId
  parentSectionId?: NodeId       // null for root section
  childSectionIds: NodeId[]

  title: string                  // "Data Model" / "User Flows" / "API Contracts"
  content: ArtifactContent
  status: ArtifactStatus

  // Independent versioning per section
  version: number                // Increments on every meaningful change to THIS section
  previousVersionId?: NodeId     // Points to prior version of this specific section

  // Approval state — sections approve independently
  committedAt?: Date
  committedBy?: string           // Session ID of the approving session

  // What decisions/constraints this specific section reflects
  sourceDecisionIds: NodeId[]
  sourceConstraintIds: NodeId[]

  provenance: Provenance
}

type ArtifactType =
  | 'spec'              // Product/technical specification document
  | 'flow'              // User flow or system flow diagram
  | 'data_model'        // Database schema or data structure
  | 'api_contract'      // API design, endpoints, contracts
  | 'code_scaffold'     // Repository structure, scaffolded code
  | 'config'            // Configuration files (Stripe, deployment, etc.)
  | 'copy'              // User-facing text, onboarding copy, etc.
  | 'architecture'      // System architecture diagram or document

type ArtifactStatus =
  | 'draft'             // Being generated, not yet reviewed
  | 'ready'             // Generated, awaiting review
  | 'approved'          // User has approved this artifact/section
  | 'committed'         // Committed and reflected in real systems
  | 'superseded'        // Replaced by a newer version
  | 'rejected'          // User rejected this artifact/section

type ArtifactContent = {
  format: 'markdown' | 'json' | 'typescript' | 'yaml' | 'diagram' | 'plaintext'
  body: string
  metadata?: Record<string, unknown>
}
```

---

## Execution State

What has actually been done in the real world.

```typescript
type ExecutionState = {
  pendingActions: ExecutionAction[]
  completedActions: ExecutionAction[]
  failedActions: ExecutionAction[]
  // Note: Integrations have moved to Workspace level
}

type ExecutionAction = {
  id: NodeId
  description: string
  service: string
  actionType: string             // "create_repo" / "create_product" / "deploy"
  parameters: Record<string, unknown>
  status: 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'rolled_back'
  sourceDecisionId?: NodeId
  sourceArtifactId?: NodeId
  sourceArtifactSectionId?: NodeId   // Can trace to a specific section now

  // Approval state
  requiresApproval: boolean
  approvedAt?: Date
  approvedBy?: string

  // Result
  result?: Record<string, unknown>
  error?: string
  completedAt?: Date

  // Reversibility
  isReversible: boolean
  rollbackActionId?: NodeId
}
```

---

## Values Model

Lives at **Workspace level**. Built silently from categorical rejections across ALL projects.
This is how Forge understands who you are as a builder, not just what you're building now.
Never displayed directly to the user — used only to inform constraint scoring and
surface patterns when explicitly relevant.

```typescript
type ValuesModel = {
  inferredPreferences: InferredPreference[]
  statedPrinciples: string[]     // Things the user has explicitly said they believe
  updatedAt: Date
}

type InferredPreference = {
  statement: string              // "Prefers simplicity over scale optionality"
  confidence: 'low' | 'medium' | 'high'
  evidenceCount: number          // How many rejections/decisions support this
  sourceRejectionIds: NodeId[]
  sourceDecisionIds: NodeId[]
  sourceProjectIds: NodeId[]     // Which projects contributed this evidence
}

type RiskProfile = {
  technical: 'conservative' | 'moderate' | 'aggressive'
  market: 'conservative' | 'moderate' | 'aggressive'
  financial: 'conservative' | 'moderate' | 'aggressive'
  // Inferred, not asked. Stored at workspace level. Never displayed directly.
}
```

---

## Session Model

A session is a **continuous working period with no significant gap in intent.**
Not a conversation. Not a day. A period of coherent work.

```typescript
type Session = {
  id: string
  projectId: NodeId
  workspaceId: string
  startedAt: Date
  endedAt?: Date

  // Session brief — generated at session START, loaded into context
  // This is what makes long-running projects possible without context bloat
  openingBrief: SessionBrief

  // What changed this session
  modelChanges: ModelChange[]

  // What the extraction engine produced this session
  extractedNodes: {
    decisions: NodeId[]
    constraints: NodeId[]
    rejections: NodeId[]
    explorations: NodeId[]
    tensions: NodeId[]
    artifacts: NodeId[]
    artifactSections: NodeId[]
  }

  // What the constraint engine surfaced this session
  escalations: Escalation[]

  // Session-level intent — what was the user trying to do this session?
  sessionGoal?: string
}

// NEW BOUNDARY RULES
// A new session starts when ANY of the following are true:
// 1. More than 4 hours have elapsed since the last turn
// 2. User explicitly closes ("let's pick this up later" / "done for now")
// 3. Primary focus shifts to a different project
// 4. A major milestone is detected (locked decisions + committed artifacts threshold met)
//
// Sessions do NOT restart just because a browser window closes or a chat ends.
// The session is defined by intent continuity, not interface continuity.

type SessionBoundaryReason =
  | 'time_gap'           // 4+ hours elapsed
  | 'explicit_close'     // User signaled end of session
  | 'project_shift'      // Focus moved to different project
  | 'milestone_reached'  // Major milestone detected structurally
  | 'workspace_init'     // First ever session

// Session brief — compressed, structured snapshot loaded at session start
// NOT a transcript. NOT a summary. A live state document.
type SessionBrief = {
  generatedAt: Date
  projectName: string
  primaryGoal: string

  // Decision state at session start
  lockedDecisions: BriefDecision[]      // These are done — just context
  decidedDecisions: BriefDecision[]     // These are committed but not locked
  pendingDecisions: BriefExploration[]  // These still need resolution

  // Active tensions
  unresolvedTensions: BriefTension[]

  // Recent changes
  changesSinceLastSession: string[]     // Human-readable list of what changed

  // What was in progress when last session ended
  lastSessionGoal: string
  lastSessionOutcome: string            // Did it get resolved? What's the status?

  // Artifact state
  artifactsInProgress: BriefArtifact[]
  recentlyCommitted: BriefArtifact[]
}

type BriefDecision = {
  statement: string
  commitment: CommitmentLevel
  category: DecisionCategory
}

type BriefExploration = {
  topic: string
  openQuestions: string[]
}

type BriefTension = {
  description: string
  severity: 'informational' | 'significant' | 'blocking'
}

type BriefArtifact = {
  name: string
  type: ArtifactType
  status: ArtifactStatus
  sectionsInProgress: number
  sectionsCommitted: number
}

type ModelChange = {
  nodeId: NodeId
  nodeType: ModelNodeType
  changeType: 'created' | 'updated' | 'promoted' | 'resolved' | 'rejected'
  previousValue?: unknown
  newValue: unknown
  turnIndex: number
}

type Escalation = {
  id: string
  triggeredAt: Date
  turnIndex: number
  reason: string                 // Why the system escalated
  constraintPropagations: ConstraintPropagation[]
  affectedNodeIds: NodeId[]
  wasAcknowledged: boolean
  userResponse?: string
}
```

---

## The Extraction Event

What the meaning extraction engine emits on every conversational turn.
This is the real-time heartbeat of the model.
Target latency: <500ms or perceived lag kills the two-track feel.

```typescript
type ConversationalTurn = {
  sessionId: string
  turnIndex: number
  speaker: 'user' | 'system'
  text: string
  timestamp: Date
}

type ExtractionResult = {
  turnRef: { sessionId: string; turnIndex: number }
  classifications: TurnClassification[]
  modelUpdates: ModelUpdate[]
  promotionChecks: PromotionCheck[]     // Did any nodes qualify for promotion?
  constraintChecksTriggered: boolean
  conflictChecksTriggered: boolean      // New: did any constraint conflicts emerge?
  escalationRequired: boolean
  escalationReason?: string
}

type TurnClassification = {
  type: TurnType
  confidence: 'high' | 'medium' | 'low'
  extractedNode?: Partial<Decision | Constraint | Rejection | Exploration | Tension>
}

type TurnType =
  | 'goal_statement'       // Defining what the project is
  | 'decision'             // Committing to a direction — requires explicit language
  | 'constraint_stated'    // Stating a hard or soft constraint
  | 'rejection'            // Ruling something out
  | 'exploration'          // Thinking out loud, not deciding — DEFAULT for ambiguous turns
  | 'approval'             // Approving a draft or suggestion — can trigger decided promotion
  | 'correction'           // Fixing a misclassification in the model
  | 'question'             // Asking, not telling
  | 'elaboration'          // Adding detail to an existing node
  | 'meta'                 // Talking about the process, not the project

// When in doubt, classify as 'exploration'.
// Erring toward exploration prevents false commitment promotions.
// The cost of under-classifying is lower than the cost of over-classifying.

type PromotionCheck = {
  nodeId: NodeId
  currentCommitment: CommitmentLevel
  candidatePromotion: CommitmentLevel
  trigger: PromotionTrigger
  isAutomatic: boolean
  requiresUserAction: boolean    // true for leaning → decided
}

type ModelUpdate = {
  operation: 'insert' | 'update' | 'promote' | 'link'
  targetLayer: 'intent' | 'decisions' | 'constraints' | 'rejections' | 'explorations' | 'tensions' | 'artifacts' | 'artifact_sections'
  nodeId: NodeId
  changes: Record<string, unknown>
}
```

---

## What This Schema Makes Possible

With this model fully populated, the system can answer:

**Constraint propagation:**
"If we commit to this decision, traverse the constraint graph — what future options close?"

**Constraint conflict detection:**
"This stated constraint scores 61. This revealed constraint scores 74. There is a conflict.
Surface it: 'You've said X but your choices consistently show Y. Which is actually the constraint?'"

**Tension detection:**
"Do any two nodes in this model conflict with each other or with the intent layer?"

**Exploration resolution:**
"Which explorations have been sitting unresolved longest? What condition would close them?"

**Values inference (workspace level):**
"Across all categorical rejections across all projects, what preferences do they reveal?
How does this new decision fit that pattern?"

**Commitment audit:**
"Show me every node that the system promoted automatically vs every node the user explicitly committed to."

**Session continuity:**
"Generate the SessionBrief for the next session. What's the current state?
What changed? What's unresolved? What was in progress?"

**Artifact diff:**
"Show me what changed between section version 3 and version 7 of the data model section."

**Historical integration (Cortex):**
"Query Cortex for past decisions matching these categories across the watched project paths.
What did we learn last time we built something like this?"

---

## Resolved Questions

All five open questions from v0.1 are now resolved:

1. ✅ **Multi-project constraints** → Workspace-level schema. Global constraints live on `Workspace`,
   inherited by projects as `inheritedGlobalConstraintIds`. Values model also moves to workspace.

2. ✅ **Conflict resolution for revealed vs stated constraints** → Scoring mechanism:
   `total = (recency × 0.25) + (frequency × 0.35) + (consistency × 0.25) + (stakes × 0.15)`
   When delta < 15 points: always surface, never auto-resolve. When delta ≥ 15: higher score wins,
   conflict still logged. The surfaced message asks the user to clarify which is real.

3. ✅ **Artifact versioning granularity** → Full section tree. Each `ArtifactSection` versions
   independently. Sections approve and commit independently. Root artifact derives a composite version.
   Changing the data model section does not bump the API contracts section.

4. ✅ **Commitment promotion rules** → Signal-driven, not time-driven. `exploring → leaning` is
   automatic on comparative preference signals. `leaning → decided` ALWAYS requires user action —
   never automatic. `decided → locked` is automatic on structural facts (3+ dependents or committed
   artifact). Full promotion history stored per node.

5. ✅ **Session boundary definition** → A session ends on: 4-hour gap, explicit close, project shift,
   or major milestone detection. Sessions are intent-continuous, not interface-continuous. Context
   bloat is managed via `SessionBrief` — a compressed structured snapshot loaded at session start,
   not a transcript. The full model lives in the graph and is queried selectively.

---

*Schema version: 0.2 — March 2026*
*GZOO Media LLC — GZOO Forge*
*Status: Draft for review — open questions resolved*
