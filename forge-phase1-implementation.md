# GZOO Forge — Phase 1 Implementation Plan
### Conversation → Project Model Pipeline

---

## What Phase 1 Delivers

A user has a conversation about a product they want to build.
In real time, as they talk, a structured project model is being built alongside.
At the end of the conversation, the model accurately captures:

- The primary goal
- All constraints (stated and beginning to reveal)
- All decisions (at correct commitment levels)
- All explorations (things thought about but not decided)
- All rejections (what was ruled out and why)
- Any tensions detected between nodes

A person who wasn't in the conversation reads the model and understands the project state.

**No artifact generation yet. No execution hooks. No UI beyond a raw model view.**
Phase 1 is the pipeline. Everything else builds on top of it.

---

## Phase 1 Success Criteria

Run a real 30-minute product conversation through the system.
The output model must satisfy ALL of:

- [ ] Primary goal captured correctly
- [ ] 5+ constraints captured (mix of stated and inferred)
- [ ] 3+ decisions at correct commitment levels
- [ ] 2+ explorations (things discussed but not decided)
- [ ] 1+ rejection with rationale
- [ ] Zero false `decided` promotions (no `leaning` auto-promoted to `decided`)
- [ ] Zero nodes written from `meta` or `question` turns
- [ ] Correction scenario handled: user corrects a node, model updates, downstream checked
- [ ] Session brief generated at end of session that accurately summarizes state

---

## Monorepo Structure

```
packages/
├── core/                    # @gzoo/forge-core
│   ├── src/
│   │   ├── types.ts         # All schema types from the design doc
│   │   ├── ids.ts           # NodeId generation (nanoid with type prefix)
│   │   ├── provenance.ts    # Provenance helpers
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── store/                   # @gzoo/forge-store
│   ├── src/
│   │   ├── events.ts        # Event log types and event sourcing primitives
│   │   ├── store.ts         # ProjectModelStore class
│   │   ├── queries.ts       # Model query helpers
│   │   ├── migrations.ts    # SQLite schema migrations
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── extract/                 # @gzoo/forge-extract
│   ├── src/
│   │   ├── classifier.ts    # Stage 1: turn type classifier
│   │   ├── extractor.ts     # Stage 2: structured node extractor
│   │   ├── prompts/
│   │   │   ├── classify.ts  # Stage 1 prompt
│   │   │   ├── decision.ts  # Stage 2 prompt for decision turns
│   │   │   ├── constraint.ts
│   │   │   ├── rejection.ts
│   │   │   ├── exploration.ts
│   │   │   └── correction.ts
│   │   ├── pipeline.ts      # Orchestrates stage 1 + 2 + store write
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
└── test-harness/            # Not published — internal testing only
    ├── scenarios/           # The 18 behavioral contract scenarios as test cases
    ├── conversations/       # Sample conversation transcripts for integration tests
    └── runner.ts            # Test runner that evaluates extraction accuracy
```

---

## Package: @gzoo/forge-core

Pure types and utilities. No I/O, no LLM, no database. Zero dependencies beyond nanoid.

### src/types.ts

This is the complete schema from the design document, compiled into TypeScript.
Key types in dependency order:

```typescript
import { NodeId, ModelNodeType } from './ids'

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
  | 'market' | 'product' | 'technical'
  | 'business' | 'operational' | 'brand'

export type ConstraintType =
  | 'technical' | 'financial' | 'market' | 'timeline'
  | 'operational' | 'aesthetic' | 'ethical' | 'regulatory' | 'strategic'

export type ConstraintSource =
  | 'stated' | 'revealed' | 'inherited' | 'workspace' | 'external'

// ─── Turn Classification ──────────────────────────────────────────────────────

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
  // If multiple types detected in one turn (Scenario 1.4), all are returned
  additionalTypes?: TurnType[]
}

// ─── Model Nodes ─────────────────────────────────────────────────────────────

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

export type CommitmentPromotion = {
  from: CommitmentLevel
  to: CommitmentLevel
  trigger: PromotionTrigger
  wasAutomatic: boolean
  sessionId: string
  turnIndex: number
  promotedAt: Date
}

export type PromotionTrigger =
  | 'comparative_preference'
  | 'return_without_question'
  | 'implicit_assumption'
  | 'explicit_commitment'
  | 'artifact_approval'
  | 'dependency_threshold'
  | 'artifact_committed'

export type ClosedOption = {
  description: string
  reversalCost: 'low' | 'medium' | 'high' | 'extreme'
  affectedDecisionIds: NodeId[]
  detectedAt: Date
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
  propagatesTo: ConstraintPropagation[]
  isRevealed: boolean
  revealedEvidence?: string[]
  conflictId?: NodeId
  scope: 'workspace' | 'project'
}

export type ConstraintPropagation = {
  affectedNodeId: NodeId
  affectedNodeType: 'decision' | 'exploration' | 'artifact' | 'option'
  impact: string
  severity: 'informational' | 'limiting' | 'blocking'
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
}

// ─── Project Model ────────────────────────────────────────────────────────────

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
  inheritedGlobalConstraintIds: NodeId[]
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

export type ScopeItem = {
  description: string
  rationale?: string
  provenance: Provenance
  commitment: CommitmentLevel
}
```

### src/ids.ts

```typescript
import { nanoid } from 'nanoid'

export type NodeId = string

export type ModelNodeType =
  | 'intent' | 'decision' | 'constraint' | 'rejection'
  | 'exploration' | 'tension' | 'artifact' | 'artifact_section'

const PREFIX_MAP: Record<ModelNodeType | 'project' | 'workspace' | 'session', string> = {
  project: 'proj',
  workspace: 'ws',
  session: 'sess',
  intent: 'int',
  decision: 'dec',
  constraint: 'con',
  rejection: 'rej',
  exploration: 'exp',
  tension: 'ten',
  artifact: 'art',
  artifact_section: 'sec',
}

export function createId(type: keyof typeof PREFIX_MAP): NodeId {
  return `${PREFIX_MAP[type]}_${nanoid(10)}`
}
```

---

## Package: @gzoo/forge-store

Event sourcing over SQLite. Current model state is derived from the event log.

### Why Event Sourcing

The schema requires:
- Full audit trail of every model change
- Rollback to any prior state
- Promotion history per decision node
- Session-level change tracking

Event sourcing gives all of this for free. The event log IS the source of truth.
The materialized project model is a projection we rebuild on demand (and cache).

### Event Types

```typescript
// src/events.ts

import { NodeId, ModelNodeType } from '@gzoo/forge-core'

export type ForgeEvent =
  | { type: 'PROJECT_CREATED';     projectId: NodeId; workspaceId: string; name: string }
  | { type: 'SESSION_STARTED';     sessionId: string; projectId: NodeId }
  | { type: 'SESSION_ENDED';       sessionId: string; reason: SessionBoundaryReason }
  | { type: 'INTENT_UPDATED';      projectId: NodeId; field: string; value: unknown; provenance: Provenance }
  | { type: 'NODE_CREATED';        nodeType: ModelNodeType; node: unknown; provenance: Provenance }
  | { type: 'NODE_UPDATED';        nodeId: NodeId; nodeType: ModelNodeType; changes: Record<string, unknown>; provenance: Provenance }
  | { type: 'NODE_PROMOTED';       nodeId: NodeId; from: CommitmentLevel; to: CommitmentLevel; trigger: PromotionTrigger; wasAutomatic: boolean; provenance: Provenance }
  | { type: 'NODE_REJECTED';       nodeId: NodeId; nodeType: ModelNodeType; reason: string; provenance: Provenance }
  | { type: 'TENSION_DETECTED';    tension: Tension }
  | { type: 'TENSION_RESOLVED';    tensionId: NodeId; resolution: string; provenance: Provenance }
  | { type: 'ESCALATION_TRIGGERED'; escalation: Escalation }
  | { type: 'CORRECTION_APPLIED';  targetNodeId: NodeId; changes: Record<string, unknown>; provenance: Provenance }

export type StoredEvent = ForgeEvent & {
  eventId: string          // nanoid
  projectId: NodeId
  sessionId: string
  turnIndex: number
  storedAt: Date
}
```

### SQLite Schema

```sql
-- src/migrations.ts (as SQL strings)

-- Event log — append only, never updated
CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,  -- JSON
  stored_at    TEXT NOT NULL    -- ISO datetime
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);

-- Materialized model cache — rebuilt from events, never source of truth
CREATE TABLE IF NOT EXISTS model_cache (
  project_id   TEXT PRIMARY KEY,
  snapshot     TEXT NOT NULL,    -- Full ProjectModel as JSON
  as_of_event  TEXT NOT NULL,    -- Last event_id included in this snapshot
  updated_at   TEXT NOT NULL
);

-- Session registry
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  end_reason   TEXT,
  turn_count   INTEGER DEFAULT 0
);

-- Turn log — raw conversation, separate from events
CREATE TABLE IF NOT EXISTS turns (
  turn_id      TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  speaker      TEXT NOT NULL,   -- 'user' | 'system'
  text         TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  classification TEXT,          -- JSON: TurnClassification[]
  extraction_result TEXT        -- JSON: ExtractionResult
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
```

### ProjectModelStore API

```typescript
// src/store.ts

export class ProjectModelStore {
  constructor(private db: Database) {}

  // ── Write ────────────────────────────────────────────────────────────────

  async appendEvent(event: ForgeEvent, context: {
    projectId: NodeId
    sessionId: string
    turnIndex: number
  }): Promise<StoredEvent>

  // ── Read ─────────────────────────────────────────────────────────────────

  // Get current materialized model (from cache or rebuilt from events)
  async getProjectModel(projectId: NodeId): Promise<ProjectModel>

  // Get model as it was at a specific event (for rollback/diff)
  async getProjectModelAtEvent(projectId: NodeId, eventId: string): Promise<ProjectModel>

  // Get all events for a session
  async getSessionEvents(sessionId: string): Promise<StoredEvent[]>

  // Get all turns for a session
  async getSessionTurns(sessionId: string): Promise<StoredTurn[]>

  // ── Session ───────────────────────────────────────────────────────────────

  async startSession(projectId: NodeId): Promise<string>  // Returns sessionId
  async endSession(sessionId: string, reason: SessionBoundaryReason): Promise<void>

  // ── Queries ───────────────────────────────────────────────────────────────

  // For commitment promotion checks
  async getDecisionDependentCount(decisionId: NodeId): Promise<number>

  // For tension detection
  async getActiveConstraints(projectId: NodeId): Promise<Constraint[]>
  async getActiveDecisions(projectId: NodeId): Promise<Decision[]>

  // For session brief generation
  async getChangesSinceSession(projectId: NodeId, sinceSessionId: string): Promise<ModelChange[]>
}
```

---

## Package: @gzoo/forge-extract

The heart of Phase 1. Two-stage extraction pipeline.

### Stage 1: Turn Classifier

Fast. Focused. One job: classify the turn type(s).
Target: under 150ms. Small model acceptable here (claude-haiku).

```typescript
// src/prompts/classify.ts

export const CLASSIFY_SYSTEM_PROMPT = `You are a turn classifier for a project intelligence system.

Your ONLY job is to classify what type of conversational turn this is.

## Turn Types

- goal_statement: The user is defining what the project is or what success looks like
- decision: The user is making an explicit commitment to a direction
  REQUIRES explicit language: "let's go with", "we'll use", "I've decided", "we're doing"
  NOT: "I think", "maybe", "probably", "I'm considering"
- constraint_stated: The user is stating a requirement or limitation
- rejection: The user is ruling something out
- exploration: The user is thinking out loud WITHOUT committing
  DEFAULT: Use this when classification is ambiguous
- approval: The user is approving something the system generated
- correction: The user is correcting a previous statement or model entry
- question: The user is asking, not telling
- elaboration: The user is adding detail to something already established
- meta: The user is talking about the process, not the project

## Critical Rules

1. A single turn can have MULTIPLE types — return all that apply
2. When uncertain between 'decision' and 'exploration': ALWAYS choose 'exploration'
3. 'decision' requires explicit commitment language — not just confidence
4. Never classify as 'decision' based on tone alone

## Output Format

Respond ONLY with valid JSON. No explanation. No preamble.

{
  "primary": "<turn_type>",
  "confidence": "high" | "medium" | "low",
  "additional": ["<turn_type>", ...] // only if multiple types present
}
`

export function buildClassifyPrompt(turn: string, recentContext: string): string {
  return `Recent conversation context:
${recentContext}

Turn to classify:
"${turn}"

Classify this turn.`
}
```

### Stage 2: Structured Extractors

One prompt per meaningful turn type.
Richer prompts, more tokens, but only runs when Stage 1 finds something worth extracting.
Target: under 350ms. claude-sonnet.

```typescript
// src/prompts/decision.ts

export const DECISION_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured decision node from a conversational turn.

A decision has been identified in this turn. Extract it precisely.

## Rules

1. statement: Rephrase as a clear declarative: "We will use X" / "This product targets Y"
2. rationale: Why did they choose this? If not stated, write "Not stated"
3. alternatives: What else was mentioned or implied as alternatives? Empty array if none
4. commitment: Based on language used:
   - 'decided': Explicit language ("let's go with", "we'll use", "we're doing")
   - 'leaning': Directional but hedged ("I think we should", "probably", "seems right")
5. certainty: How confident does the user seem about this decision?
   - 'assumed': Stated matter-of-factly without argument
   - 'evidenced': User gave a reason or cited experience
   - 'uncertain': User expressed doubt alongside the decision
6. category: Which domain does this decision belong to?

## Output Format

Respond ONLY with valid JSON. No explanation.

{
  "statement": "<clear declarative statement>",
  "rationale": "<why, or 'Not stated'>",
  "alternatives": ["<alt1>", "<alt2>"],
  "commitment": "decided" | "leaning",
  "certainty": "assumed" | "uncertain" | "evidenced" | "validated",
  "category": "market" | "product" | "technical" | "business" | "operational" | "brand"
}
`

// src/prompts/constraint.ts

export const CONSTRAINT_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured constraint node from a conversational turn.

A constraint has been identified — something the project must do, must not do, or is limited by.

## Rules

1. statement: Rephrase as a clear requirement: "Must X" / "Cannot Y" / "Under Z"
2. hardness:
   - 'hard': Non-negotiable. "We must", "it has to", "absolutely"
   - 'soft': Strong preference but could flex. "I'd prefer", "ideally", "try to"
3. type: What domain does this constraint belong to?
4. source: Always 'stated' for direct extraction from conversation
5. isRevealed: Always false for direct extraction (revealed constraints are inferred later)

## Output Format

Respond ONLY with valid JSON.

{
  "statement": "<clear constraint statement>",
  "hardness": "hard" | "soft",
  "type": "technical" | "financial" | "market" | "timeline" | "operational" | "aesthetic" | "ethical" | "regulatory" | "strategic",
  "certainty": "assumed" | "uncertain" | "evidenced",
  "source": "stated",
  "isRevealed": false
}
`

// src/prompts/rejection.ts

export const REJECTION_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured rejection node from a conversational turn.

The user has ruled something out. Extract the rejection precisely.

## Rules

1. statement: What was rejected? Rephrase as "We will NOT use/do X"
2. rejectionType:
   - 'categorical': "That's wrong", "I don't want that", "definitely not" — permanent
   - 'conditional': "Not now because X", "maybe later if Y" — conditional on change
   - 'deferred': "Maybe", "later", "not this version" — low signal, keep quietly
3. reason: Why was it rejected? Critical — if not stated, still try to infer from context
4. revivalCondition: For conditional rejections only — what would change this?
5. revealsPreference: For categorical rejections — what does this reveal about how they build?
   e.g. "Not building on Vercel because of vendor lock-in" → "Prefers avoiding platform lock-in"
6. contributesToValues: true for categorical rejections, false for conditional/deferred

## Output Format

Respond ONLY with valid JSON.

{
  "statement": "<what was rejected>",
  "rejectionType": "categorical" | "conditional" | "deferred",
  "reason": "<why>",
  "revivalCondition": "<condition or null>",
  "revealsPreference": "<preference revealed or null>",
  "contributesToValues": true | false
}
`

// src/prompts/exploration.ts

export const EXPLORATION_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured exploration node from a conversational turn.

The user is thinking through something without committing. Preserve the ambiguity — 
do NOT resolve it. Your job is to capture what's being explored, not to decide it.

## Rules

1. topic: What is being explored? Short phrase, e.g. "Database selection" / "Pricing model"
2. direction: What general direction is the thinking pointing? Can be vague.
3. openQuestions: What questions remain unresolved? Extract them explicitly.
4. consideredOptions: What options have been mentioned? Even ones being compared.
5. resolutionCondition: What would allow this to be decided? If not stated, null.

## Output Format

Respond ONLY with valid JSON.

{
  "topic": "<short topic phrase>",
  "direction": "<general direction of thinking>",
  "openQuestions": ["<question1>", "<question2>"],
  "consideredOptions": ["<option1>", "<option2>"],
  "resolutionCondition": "<condition or null>"
}
`

// src/prompts/correction.ts

export const CORRECTION_EXTRACT_SYSTEM_PROMPT = `You are extracting a correction from a conversational turn.

The user is correcting something previously said or previously in the model.
Extract what is being corrected and what the correct version is.

## Output Format

Respond ONLY with valid JSON.

{
  "correcting": "<what is being corrected — quote or describe the original>",
  "correction": "<the correct version>",
  "isPermanent": true | false,  // false if this is a soft clarification
  "reason": "<why the correction is being made, if stated>"
}
`
```

### Pipeline Orchestrator

```typescript
// src/pipeline.ts

import { ProjectModelStore } from '@gzoo/forge-store'
import { classify } from './classifier'
import { extract } from './extractor'
import { createId } from '@gzoo/forge-core'
import type {
  ConversationalTurn, ExtractionResult, TurnType,
  Decision, Constraint, Rejection, Exploration, NodeId
} from '@gzoo/forge-core'

export class ExtractionPipeline {
  constructor(
    private store: ProjectModelStore,
    private llmClient: LLMClient  // Abstracted — Anthropic or Ollama
  ) {}

  async processTurn(
    turn: ConversationalTurn,
    projectId: NodeId
  ): Promise<ExtractionResult> {

    const startTime = Date.now()

    // Stage 1: Classify
    const recentContext = await this.getRecentContext(turn.sessionId, turn.turnIndex)
    const classification = await classify(turn.text, recentContext, this.llmClient)

    // Early exit for turns that don't produce model updates
    const noOpTypes: TurnType[] = ['question', 'meta']
    const allTypes = [classification.primary, ...(classification.additional ?? [])]
    if (allTypes.every(t => noOpTypes.includes(t))) {
      return {
        turnRef: { sessionId: turn.sessionId, turnIndex: turn.turnIndex },
        classifications: [{ type: classification.primary, confidence: classification.confidence }],
        modelUpdates: [],
        promotionChecks: [],
        constraintChecksTriggered: false,
        conflictChecksTriggered: false,
        escalationRequired: false,
      }
    }

    // Stage 2: Extract per classification type
    const modelUpdates = []
    const promotionChecks = []

    for (const turnType of allTypes) {
      if (noOpTypes.includes(turnType)) continue

      const provenance = {
        sessionId: turn.sessionId,
        turnIndex: turn.turnIndex,
        extractedAt: new Date(),
        confidence: classification.confidence,
        rawTurn: turn.text,
      }

      const extracted = await extract(turnType, turn.text, recentContext, provenance, this.llmClient)

      if (extracted) {
        const update = await this.writeToModel(extracted, turnType, projectId, provenance)
        modelUpdates.push(update)

        // Check for promotion eligibility after write
        const promoCheck = await this.checkPromotionEligibility(extracted, turnType, projectId)
        if (promoCheck) promotionChecks.push(promoCheck)
      }
    }

    // Check for tensions after all nodes are written
    const tensionCheck = await this.checkForTensions(projectId)

    // Check if escalation is needed
    const escalation = await this.checkEscalation(modelUpdates, projectId)

    const elapsed = Date.now() - startTime
    // Log if over 500ms target
    if (elapsed > 500) {
      console.warn(`[forge-extract] Turn ${turn.turnIndex} took ${elapsed}ms (target: 500ms)`)
    }

    return {
      turnRef: { sessionId: turn.sessionId, turnIndex: turn.turnIndex },
      classifications: [{ type: classification.primary, confidence: classification.confidence }],
      modelUpdates,
      promotionChecks,
      constraintChecksTriggered: modelUpdates.some(u =>
        u.targetLayer === 'constraints' || u.targetLayer === 'decisions'
      ),
      conflictChecksTriggered: false, // Phase 1: detect but not resolve
      escalationRequired: !!escalation,
      escalationReason: escalation?.reason,
    }
  }

  private async getRecentContext(sessionId: string, currentTurnIndex: number): Promise<string> {
    // Get last 5 turns for context window
    const turns = await this.store.getSessionTurns(sessionId)
    return turns
      .filter(t => t.turn_index < currentTurnIndex)
      .slice(-5)
      .map(t => `${t.speaker}: ${t.text}`)
      .join('\n')
  }

  private async writeToModel(
    extracted: unknown,
    turnType: TurnType,
    projectId: NodeId,
    provenance: Provenance
  ): Promise<ModelUpdate> {
    // Maps turn type to the correct event type and store operation
    // Returns ModelUpdate for the ExtractionResult
    // ... implementation
  }

  private async checkPromotionEligibility(
    node: unknown,
    turnType: TurnType,
    projectId: NodeId
  ): Promise<PromotionCheck | null> {
    // Checks:
    // 1. comparative_preference signal in the turn text
    // 2. return_without_question: has this node been referenced in 3+ recent turns without question?
    // 3. dependency_threshold: does this decision have 3+ dependents? (decided → locked)
    // Note: leaning → decided is NEVER automatic — return null for that transition
    // ... implementation
  }

  private async checkForTensions(projectId: NodeId): Promise<void> {
    // After any model write, check for conflicts between:
    // - New node vs intent layer
    // - New node vs existing constraints
    // - New node vs existing decisions in same category
    // Write Tension events if found
    // ... implementation
  }

  private async checkEscalation(
    updates: ModelUpdate[],
    projectId: NodeId
  ): Promise<{ reason: string } | null> {
    // Escalation threshold: material constraint propagation only
    // NOT: aesthetic decisions, minor scope items, low-propagation constraints
    // YES: market decisions that conflict with pricing direction
    //      technical decisions that create architectural lock-in
    //      scope expansions that conflict with stated intent
    // ... implementation
  }
}
```

---

## Package: test-harness

Before integration testing, the behavioral contract scenarios run as unit tests.

### Structure

```typescript
// scenarios/1-1-thinking-out-loud.ts

import { describe, it, expect } from 'vitest'
import { classify } from '@gzoo/forge-extract'

describe('Scenario 1.1 — Thinking Out Loud', () => {
  it('should classify as exploration, not decision', async () => {
    const turn = "I'm thinking maybe we use Postgres for the database. Or maybe SQLite since this is local-first. I don't know, what do you think?"

    const result = await classify(turn, '', mockLLM)

    expect(result.primary).toBe('exploration')
    expect(result.primary).not.toBe('decision')
  })

  it('should not produce a decision node on extraction', async () => {
    // Run through full pipeline
    // Assert: no decision node in model
    // Assert: exploration node written with correct topic
  })
})

// scenarios/2-2-locked-gate.ts

describe('Scenario 2.2 — The Locked Gate', () => {
  it('should never auto-promote leaning to decided regardless of signal strength', async () => {
    // Set up: decision node at 'leaning' with 4 supporting turns, 2 dependents
    // Run another supporting turn through pipeline
    // Assert: commitment stays at 'leaning'
    // Assert: NO auto-promotion event in event log
    // Assert: promotion check returned requiresUserAction: true
  })
})
```

Every scenario from the behavioral contract becomes a test.
The test suite is the definition of "Phase 1 working correctly."

---

## Build Sequence Within Phase 1

**Week 1: Core + Store**
1. `@gzoo/forge-core` — types, ids, provenance (1-2 days)
2. `@gzoo/forge-store` — SQLite schema, event log, basic model materialization (3-4 days)
3. Unit tests for store: event append, model rebuild from events, session management

**Week 2: Extract — Stage 1**
4. Stage 1 classifier — prompt engineering + integration (2-3 days)
5. Behavioral contract unit tests for classification scenarios 1.1–1.5 (1-2 days)
6. Iteration on classifier until scenarios pass

**Week 3: Extract — Stage 2**
7. Stage 2 extractors — one per turn type (3-4 days)
8. Pipeline orchestrator — connects Stage 1 → Stage 2 → store write (1-2 days)
9. Behavioral contract unit tests for promotion scenarios 2.1–2.3

**Week 4: Integration + Polish**
10. Full pipeline integration test: 30-minute real conversation
11. Behavioral contract scenarios 3–7 (constraint, trust, session, artifact)
12. Performance optimization if any turns exceeding 500ms
13. Session brief generation
14. Phase 1 success criteria evaluation

---

## What Claude Code Needs to Build Phase 1

The implementation agent needs:

1. **This document** — the full spec
2. **forge-project-model-v2.md** — the complete schema
3. **forge-behavioral-contract.md** — the test definitions
4. **Node.js 20+, TypeScript strict mode**
5. **Dependencies:**
   - `better-sqlite3` — SQLite driver (same as Cortex)
   - `nanoid` — NodeId generation
   - `@anthropic-ai/sdk` — LLM client
   - `vitest` — test runner

**The one instruction Claude Code must not deviate from:**
The `leaning → decided` promotion is NEVER automatic.
No clever interpretation, no "strong enough signals" exception.
If a test is failing because the system won't auto-promote, the test is wrong, not the rule.

---

## Phase 1 Deliverable

A Node.js CLI that:

```bash
# Start a new project and session
forge init "Build a dispatch SaaS for HVAC"

# Process a turn (in real usage this is called programmatically per conversational turn)
forge turn "I'm thinking we use Postgres for the database, maybe SQLite..."

# View current project model
forge model

# View event log
forge events

# View session brief
forge brief

# Run behavioral contract test suite
forge test
```

The CLI is not the product — it's the Phase 1 test surface.
The real interface comes in a later phase.

---

*Phase 1 Implementation Plan — v1.0*
*GZOO Media LLC — GZOO Forge*
*March 2026*
