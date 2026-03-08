import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import {
  createId,
  type NodeId,
  type ProjectModel,
  type IntentLayer,
  type Decision,
  type Constraint,
  type Rejection,
  type Exploration,
  type Tension,
  type Artifact,
  type SessionBoundaryReason,
  type ModelChange,
  type ModelNodeType,
  type TurnClassification,
  type ExtractionResult,
  type CommitmentLevel,
  type SurfacingEvent,
  type SurfacingType,
  type TrustMetrics,
  type Workspace,
  type ValuesModel,
  type RiskProfile,
  type InferredPreference,
  type MemoryMatch,
  type MemoryQuery,
  type MemoryResult,
} from '@gzoo/forge-core'
import type { ForgeEvent, StoredEvent, StoredTurn } from './events'
import { runMigrations } from './migrations'
import { expandWithSynonyms } from './synonyms'

export class ProjectModelStore {
  private db: Database.Database

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    runMigrations(this.db)
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  appendEvent(event: ForgeEvent, context: {
    projectId: NodeId
    sessionId: string
    turnIndex: number
  }): StoredEvent {
    const eventId = nanoid(10)
    const storedAt = new Date()

    const stored: StoredEvent = {
      ...event,
      eventId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      turnIndex: context.turnIndex,
      storedAt,
    }

    const { type, ...rest } = event
    const payload = JSON.stringify(rest, (_, value) => {
      if (value instanceof Map) {
        return { __type: 'Map', entries: Array.from(value.entries()) }
      }
      return value
    })

    this.db.prepare(`
      INSERT INTO events (event_id, project_id, session_id, turn_index, type, payload, stored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, context.projectId, context.sessionId, context.turnIndex, type, payload, storedAt.toISOString())

    // Invalidate model cache after any event
    this.invalidateCache(context.projectId)

    return stored
  }

  appendTurn(turn: {
    sessionId: string
    projectId: NodeId
    turnIndex: number
    speaker: 'user' | 'system'
    text: string
    timestamp: Date
    classification?: TurnClassification[]
    extractionResult?: ExtractionResult
  }): StoredTurn {
    const turnId = nanoid(10)

    this.db.prepare(`
      INSERT INTO turns (turn_id, session_id, project_id, turn_index, speaker, text, timestamp, classification, extraction_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turnId,
      turn.sessionId,
      turn.projectId,
      turn.turnIndex,
      turn.speaker,
      turn.text,
      turn.timestamp.toISOString(),
      turn.classification ? JSON.stringify(turn.classification) : null,
      turn.extractionResult ? JSON.stringify(turn.extractionResult) : null,
    )

    // Update session turn count
    this.db.prepare(`
      UPDATE sessions SET turn_count = turn_count + 1 WHERE session_id = ?
    `).run(turn.sessionId)

    return {
      turnId,
      sessionId: turn.sessionId,
      projectId: turn.projectId,
      turnIndex: turn.turnIndex,
      speaker: turn.speaker,
      text: turn.text,
      timestamp: turn.timestamp,
      classification: turn.classification,
      extractionResult: turn.extractionResult,
    }
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  getProjectModel(projectId: NodeId): ProjectModel {
    // Check cache first
    const cached = this.getCachedModel(projectId)
    if (cached) return cached

    // Rebuild from events
    const model = this.rebuildModel(projectId)
    this.cacheModel(projectId, model)
    return model
  }

  getProjectModelAtEvent(projectId: NodeId, eventId: string): ProjectModel {
    const events = this.getEventsUpTo(projectId, eventId)
    return this.applyEvents(this.createEmptyModel(projectId), events)
  }

  getSessionEvents(sessionId: string): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT event_id, project_id, session_id, turn_index, type, payload, stored_at
      FROM events WHERE session_id = ? ORDER BY rowid
    `).all(sessionId) as EventRow[]

    return rows.map(this.rowToStoredEvent)
  }

  getSessionTurns(sessionId: string): StoredTurn[] {
    const rows = this.db.prepare(`
      SELECT turn_id, session_id, project_id, turn_index, speaker, text, timestamp, classification, extraction_result
      FROM turns WHERE session_id = ? ORDER BY turn_index
    `).all(sessionId) as TurnRow[]

    return rows.map(this.rowToStoredTurn)
  }

  getAllEvents(projectId: NodeId): StoredEvent[] {
    const rows = this.db.prepare(`
      SELECT event_id, project_id, session_id, turn_index, type, payload, stored_at
      FROM events WHERE project_id = ? ORDER BY rowid
    `).all(projectId) as EventRow[]

    return rows.map(this.rowToStoredEvent)
  }

  // ── Session ────────────────────────────────────────────────────────────────

  startSession(projectId: NodeId): string {
    const sessionId = createId('session')

    this.db.prepare(`
      INSERT INTO sessions (session_id, project_id, started_at, turn_count)
      VALUES (?, ?, ?, 0)
    `).run(sessionId, projectId, new Date().toISOString())

    this.appendEvent(
      { type: 'SESSION_STARTED', sessionId, projectId },
      { projectId, sessionId, turnIndex: 0 }
    )

    return sessionId
  }

  endSession(sessionId: string, reason: SessionBoundaryReason): void {
    const session = this.db.prepare(`
      SELECT project_id FROM sessions WHERE session_id = ?
    `).get(sessionId) as { project_id: string } | undefined

    if (!session) throw new Error(`Session not found: ${sessionId}`)

    this.db.prepare(`
      UPDATE sessions SET ended_at = ?, end_reason = ? WHERE session_id = ?
    `).run(new Date().toISOString(), reason, sessionId)

    this.appendEvent(
      { type: 'SESSION_ENDED', sessionId, reason },
      { projectId: session.project_id, sessionId, turnIndex: -1 }
    )
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getDecisionDependentCount(decisionId: NodeId): number {
    // Count how many decisions list this decisionId in their dependsOn
    const model = this.getProjectModelFromLatestEvent(decisionId)
    if (!model) return 0

    let count = 0
    for (const [, decision] of model.decisions) {
      if (decision.dependsOn.includes(decisionId)) {
        count++
      }
    }
    return count
  }

  getActiveConstraints(projectId: NodeId): Constraint[] {
    const model = this.getProjectModel(projectId)
    return Array.from(model.constraints.values())
  }

  getActiveDecisions(projectId: NodeId): Decision[] {
    const model = this.getProjectModel(projectId)
    return Array.from(model.decisions.values())
  }

  getChangesSinceSession(projectId: NodeId, sinceSessionId: string): ModelChange[] {
    // Get all events after the given session ended
    const sessionEnd = this.db.prepare(`
      SELECT ended_at FROM sessions WHERE session_id = ?
    `).get(sinceSessionId) as { ended_at: string | null } | undefined

    if (!sessionEnd?.ended_at) return []

    const rows = this.db.prepare(`
      SELECT event_id, project_id, session_id, turn_index, type, payload, stored_at
      FROM events
      WHERE project_id = ? AND stored_at > ?
      ORDER BY rowid
    `).all(projectId, sessionEnd.ended_at) as EventRow[]

    return rows.map(row => {
      const event = this.rowToStoredEvent(row)
      return this.eventToModelChange(event)
    }).filter((c): c is ModelChange => c !== null)
  }

  // ── Workspace Lifecycle ────────────────────────────────────────────────────

  createWorkspace(name: string): string {
    const id = `ws_${nanoid(10)}`
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO workspaces (workspace_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, name, now, now)

    return id
  }

  getWorkspace(workspaceId: string): Workspace | null {
    const row = this.db.prepare(`
      SELECT workspace_id, name, created_at, updated_at, values_model, risk_profile, cortex_config
      FROM workspaces WHERE workspace_id = ?
    `).get(workspaceId) as WorkspaceRow | undefined

    if (!row) return null

    const projectRows = this.db.prepare(`
      SELECT project_id FROM workspace_projects WHERE workspace_id = ?
    `).all(workspaceId) as { project_id: string }[]

    return {
      id: row.workspace_id,
      name: row.name,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      valuesModel: JSON.parse(row.values_model),
      riskProfile: JSON.parse(row.risk_profile),
      globalConstraints: new Map(),
      integrations: [],
      projectIds: projectRows.map(r => r.project_id),
    }
  }

  updateValuesModel(workspaceId: string, valuesModel: ValuesModel): void {
    this.db.prepare(`
      UPDATE workspaces SET values_model = ?, updated_at = ? WHERE workspace_id = ?
    `).run(JSON.stringify(valuesModel), new Date().toISOString(), workspaceId)
  }

  updateRiskProfile(workspaceId: string, riskProfile: RiskProfile): void {
    this.db.prepare(`
      UPDATE workspaces SET risk_profile = ?, updated_at = ? WHERE workspace_id = ?
    `).run(JSON.stringify(riskProfile), new Date().toISOString(), workspaceId)
  }

  // ── Project Lifecycle ──────────────────────────────────────────────────────

  createProject(workspaceId: string, name: string): NodeId {
    const projectId = createId('project')

    // Ensure workspace exists
    const wsExists = this.db.prepare(`
      SELECT 1 FROM workspaces WHERE workspace_id = ?
    `).get(workspaceId)
    if (!wsExists) {
      this.createWorkspace(workspaceId === 'ws_default' ? 'Default Workspace' : workspaceId)
      // If workspace was auto-created with a different ID, fix it
      if (workspaceId === 'ws_default') {
        this.db.prepare(`DELETE FROM workspaces WHERE workspace_id != ?`).run(workspaceId)
        const now = new Date().toISOString()
        this.db.prepare(`
          INSERT OR IGNORE INTO workspaces (workspace_id, name, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run('ws_default', 'Default Workspace', now, now)
      }
    }

    // Link project to workspace
    this.db.prepare(`
      INSERT OR IGNORE INTO workspace_projects (workspace_id, project_id, added_at)
      VALUES (?, ?, ?)
    `).run(workspaceId, projectId, new Date().toISOString())

    this.appendEvent(
      { type: 'PROJECT_CREATED', projectId, workspaceId, name },
      { projectId, sessionId: '', turnIndex: 0 }
    )

    return projectId
  }

  // ── Cross-Project Memory ────────────────────────────────────────────────────

  queryMemory(query: MemoryQuery): MemoryResult {
    const startTime = Date.now()
    const matches: MemoryMatch[] = []

    // Get all project IDs in this workspace (excluding current project if specified)
    const projectRows = this.db.prepare(`
      SELECT DISTINCT project_id FROM events WHERE type = 'PROJECT_CREATED'
    `).all() as { project_id: string }[]

    const projectIds = projectRows
      .map(r => r.project_id)
      .filter(id => id !== query.excludeProjectId)

    for (const projectId of projectIds) {
      const model = this.getProjectModel(projectId)

      // Search decisions for relevant matches
      if (query.currentDecision) {
        for (const [, decision] of model.decisions) {
          if (query.categories && !query.categories.includes(decision.category)) continue
          const score = this.computeRelevance(query.currentDecision, decision.statement)
          if (score >= 30) {
            matches.push({
              projectId,
              projectName: model.name,
              nodeType: 'decision',
              statement: decision.statement,
              category: decision.category,
              outcome: decision.commitment === 'locked'
                ? 'Locked — became load-bearing'
                : decision.commitment === 'decided'
                ? 'Committed'
                : undefined,
              relevanceScore: score,
              matchReason: `Similar decision in "${model.name}"`,
            })
          }
        }

        // Search rejections — what was ruled out and why
        for (const [, rejection] of model.rejections) {
          const score = this.computeRelevance(query.currentDecision, rejection.statement)
          if (score >= 30) {
            matches.push({
              projectId,
              projectName: model.name,
              nodeType: 'rejection',
              statement: rejection.statement,
              category: rejection.category,
              outcome: `Rejected: ${rejection.reason}`,
              relevanceScore: score + 10, // Rejections are extra valuable
              matchReason: `Previously rejected in "${model.name}" — ${rejection.reason}`,
            })
          }
        }
      }

      // Search explorations for related topics
      if (query.currentExploration) {
        for (const [, exploration] of model.explorations) {
          const score = this.computeRelevance(query.currentExploration, exploration.topic)
          if (score >= 30) {
            matches.push({
              projectId,
              projectName: model.name,
              nodeType: 'exploration',
              statement: exploration.topic,
              outcome: exploration.status === 'resolved'
                ? `Resolved → ${exploration.resolvedToDecisionId ?? 'decided'}`
                : exploration.status,
              relevanceScore: score,
              matchReason: `Explored in "${model.name}"`,
            })
          }
        }
      }
    }

    // Sort by relevance, cap at 5
    matches.sort((a, b) => b.relevanceScore - a.relevanceScore)
    const topMatches = matches.slice(0, 5)

    return {
      matches: topMatches,
      queryTime: Date.now() - startTime,
      source: 'local',
    }
  }

  buildValuesModel(workspaceId: string): ValuesModel {
    // Get all projects in this workspace
    const projectRows = this.db.prepare(`
      SELECT project_id FROM workspace_projects WHERE workspace_id = ?
    `).all(workspaceId) as { project_id: string }[]

    const preferences: Map<string, InferredPreference> = new Map()

    for (const { project_id } of projectRows) {
      const model = this.getProjectModel(project_id)

      // Build preferences from categorical rejections
      for (const [, rejection] of model.rejections) {
        if (rejection.rejectionType !== 'categorical') continue
        if (!rejection.revealsPreference) continue

        const key = rejection.revealsPreference.toLowerCase()
        const existing = preferences.get(key)

        if (existing) {
          existing.evidenceCount++
          existing.sourceRejectionIds.push(rejection.id)
          if (!existing.sourceProjectIds.includes(project_id)) {
            existing.sourceProjectIds.push(project_id)
          }
          // More evidence → higher confidence
          existing.confidence = existing.evidenceCount >= 3 ? 'high' :
                                existing.evidenceCount >= 2 ? 'medium' : 'low'
        } else {
          preferences.set(key, {
            statement: rejection.revealsPreference,
            confidence: 'low',
            evidenceCount: 1,
            sourceRejectionIds: [rejection.id],
            sourceDecisionIds: [],
            sourceProjectIds: [project_id],
          })
        }
      }
    }

    const valuesModel: ValuesModel = {
      inferredPreferences: Array.from(preferences.values()),
      statedPrinciples: [], // Populated by explicit user statements
      updatedAt: new Date(),
    }

    // Persist to workspace
    this.updateValuesModel(workspaceId, valuesModel)

    return valuesModel
  }

  inferRiskProfile(workspaceId: string): RiskProfile {
    const projectRows = this.db.prepare(`
      SELECT project_id FROM workspace_projects WHERE workspace_id = ?
    `).all(workspaceId) as { project_id: string }[]

    let techConservative = 0, techAggressive = 0
    let marketConservative = 0, marketAggressive = 0
    let financialConservative = 0, financialAggressive = 0
    let total = 0

    for (const { project_id } of projectRows) {
      const model = this.getProjectModel(project_id)

      for (const [, decision] of model.decisions) {
        total++
        // Technical risk signals
        if (decision.category === 'technical') {
          if (decision.certainty === 'validated' || decision.certainty === 'evidenced') {
            techConservative++
          } else if (decision.certainty === 'assumed') {
            techAggressive++
          }
        }
        // Market risk signals
        if (decision.category === 'market') {
          if (decision.alternatives.length > 2) marketConservative++
          else marketAggressive++
        }
        // Financial risk signals
        if (decision.category === 'business') {
          if (decision.certainty === 'validated') financialConservative++
          else if (decision.certainty === 'assumed') financialAggressive++
        }
      }
    }

    const classify = (cons: number, agg: number): 'conservative' | 'moderate' | 'aggressive' => {
      if (total === 0) return 'moderate'
      if (cons > agg * 2) return 'conservative'
      if (agg > cons * 2) return 'aggressive'
      return 'moderate'
    }

    const profile: RiskProfile = {
      technical: classify(techConservative, techAggressive),
      market: classify(marketConservative, marketAggressive),
      financial: classify(financialConservative, financialAggressive),
    }

    this.updateRiskProfile(workspaceId, profile)
    return profile
  }

  private computeRelevance(query: string, target: string): number {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    const targetWords = target.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    if (queryWords.length === 0 || targetWords.length === 0) return 0

    // Expand both sides with domain synonyms
    const expandedQuery = expandWithSynonyms(queryWords)
    const expandedTarget = expandWithSynonyms(targetWords)

    // Direct word overlap
    const directOverlap = queryWords.filter(w => targetWords.includes(w))

    // Synonym-expanded overlap (query words matching expanded target, and vice versa)
    const synonymOverlap = queryWords.filter(w =>
      !directOverlap.includes(w) && expandedTarget.includes(w)
    ).length + targetWords.filter(w =>
      !directOverlap.includes(w) && expandedQuery.includes(w)
    ).length

    const effectiveOverlap = directOverlap.length + (synonymOverlap * 0.6)
    const overlapRatio = effectiveOverlap / Math.max(queryWords.length, 1)
    return Math.min(100, Math.round(overlapRatio * 100) + (directOverlap.length * 10) + (synonymOverlap * 5))
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private getCachedModel(projectId: NodeId): ProjectModel | null {
    const row = this.db.prepare(`
      SELECT snapshot, as_of_event FROM model_cache WHERE project_id = ?
    `).get(projectId) as { snapshot: string; as_of_event: string } | undefined

    if (!row) return null

    // Check if cache is current
    const latestEvent = this.db.prepare(`
      SELECT event_id FROM events WHERE project_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(projectId) as { event_id: string } | undefined

    if (!latestEvent || latestEvent.event_id !== row.as_of_event) return null

    return this.deserializeModel(row.snapshot)
  }

  private cacheModel(projectId: NodeId, model: ProjectModel): void {
    const latestEvent = this.db.prepare(`
      SELECT event_id FROM events WHERE project_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(projectId) as { event_id: string } | undefined

    if (!latestEvent) return

    const snapshot = this.serializeModel(model)

    this.db.prepare(`
      INSERT OR REPLACE INTO model_cache (project_id, snapshot, as_of_event, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(projectId, snapshot, latestEvent.event_id, new Date().toISOString())
  }

  private invalidateCache(projectId: NodeId): void {
    this.db.prepare(`DELETE FROM model_cache WHERE project_id = ?`).run(projectId)
  }

  private rebuildModel(projectId: NodeId): ProjectModel {
    const events = this.getAllEvents(projectId)
    return this.applyEvents(this.createEmptyModel(projectId), events)
  }

  private getEventsUpTo(projectId: NodeId, eventId: string): StoredEvent[] {
    // Get the rowid of the target event
    const target = this.db.prepare(`
      SELECT rowid FROM events WHERE event_id = ?
    `).get(eventId) as { rowid: number } | undefined

    if (!target) return []

    const rows = this.db.prepare(`
      SELECT event_id, project_id, session_id, turn_index, type, payload, stored_at
      FROM events WHERE project_id = ? AND rowid <= ?
      ORDER BY rowid
    `).all(projectId, target.rowid) as EventRow[]

    return rows.map(this.rowToStoredEvent)
  }

  private getProjectModelFromLatestEvent(nodeId: NodeId): ProjectModel | null {
    // Find which project this node belongs to by searching events
    const row = this.db.prepare(`
      SELECT project_id FROM events
      WHERE payload LIKE ? OR payload LIKE ?
      LIMIT 1
    `).get(`%"id":"${nodeId}"%`, `%"nodeId":"${nodeId}"%`) as { project_id: string } | undefined

    if (!row) return null
    return this.getProjectModel(row.project_id)
  }

  private createEmptyModel(projectId: NodeId): ProjectModel {
    return {
      id: projectId,
      workspaceId: '',
      name: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 0,
      sessionIds: [],
      intent: {
        primaryGoal: null,
        scope: { inScope: [], outOfScope: [], unknownScope: [] },
        qualityBar: null,
        successMetrics: [],
        antiGoals: [],
      },
      decisions: new Map(),
      constraints: new Map(),
      rejections: new Map(),
      explorations: new Map(),
      tensions: new Map(),
      artifacts: new Map(),
      inheritedGlobalConstraintIds: [],
    }
  }

  private applyEvents(model: ProjectModel, events: StoredEvent[]): ProjectModel {
    for (const event of events) {
      this.applyEvent(model, event)
    }
    return model
  }

  private applyEvent(model: ProjectModel, event: StoredEvent): void {
    model.updatedAt = event.storedAt
    model.version++

    switch (event.type) {
      case 'PROJECT_CREATED':
        model.workspaceId = event.workspaceId
        model.name = event.name
        model.createdAt = event.storedAt
        break

      case 'SESSION_STARTED':
        if (!model.sessionIds.includes(event.sessionId)) {
          model.sessionIds.push(event.sessionId)
        }
        break

      case 'SESSION_ENDED':
        // Session end is tracked in sessions table, no model change needed
        break

      case 'INTENT_UPDATED':
        this.applyIntentUpdate(model.intent, event.field, event.value)
        break

      case 'NODE_CREATED':
        this.applyNodeCreated(model, event.nodeType, event.node)
        break

      case 'NODE_UPDATED':
        this.applyNodeUpdated(model, event.nodeId, event.nodeType, event.changes)
        break

      case 'NODE_PROMOTED':
        this.applyNodePromoted(model, event)
        break

      case 'NODE_REJECTED':
        this.applyNodeRejected(model, event.nodeId, event.nodeType, event.reason, event.provenance)
        break

      case 'TENSION_DETECTED':
        model.tensions.set(event.tension.id, event.tension)
        break

      case 'TENSION_RESOLVED': {
        const tension = model.tensions.get(event.tensionId)
        if (tension) {
          tension.status = 'resolved'
          tension.resolution = event.resolution
          tension.resolvedAt = event.storedAt
          tension.resolvedBy = event.provenance
        }
        break
      }

      case 'ESCALATION_TRIGGERED':
        // Escalations are session-level, not stored in the project model
        break

      case 'CORRECTION_APPLIED':
        this.applyCorrectionToModel(model, event.targetNodeId, event.changes)
        break
    }
  }

  private applyIntentUpdate(intent: IntentLayer, field: string, value: unknown): void {
    switch (field) {
      case 'primaryGoal':
        intent.primaryGoal = value as IntentLayer['primaryGoal']
        break
      case 'scope':
        intent.scope = value as IntentLayer['scope']
        break
      case 'scope.inScope':
        intent.scope.inScope = value as IntentLayer['scope']['inScope']
        break
      case 'scope.outOfScope':
        intent.scope.outOfScope = value as IntentLayer['scope']['outOfScope']
        break
      case 'qualityBar':
        intent.qualityBar = value as IntentLayer['qualityBar']
        break
      case 'successMetrics':
        intent.successMetrics = value as IntentLayer['successMetrics']
        break
      case 'antiGoals':
        intent.antiGoals = value as IntentLayer['antiGoals']
        break
    }
  }

  private applyNodeCreated(model: ProjectModel, nodeType: ModelNodeType, node: unknown): void {
    const n = node as { id: NodeId }
    switch (nodeType) {
      case 'decision':
        model.decisions.set(n.id, node as Decision)
        break
      case 'constraint':
        model.constraints.set(n.id, node as Constraint)
        break
      case 'rejection':
        model.rejections.set(n.id, node as Rejection)
        break
      case 'exploration':
        model.explorations.set(n.id, node as Exploration)
        break
      case 'tension':
        model.tensions.set(n.id, node as Tension)
        break
      case 'artifact':
        model.artifacts.set(n.id, node as Artifact)
        break
    }
  }

  private applyNodeUpdated(model: ProjectModel, nodeId: NodeId, nodeType: ModelNodeType, changes: Record<string, unknown>): void {
    const map = this.getMapForType(model, nodeType)
    if (!map) return
    const node = map.get(nodeId)
    if (!node) return
    Object.assign(node, changes)
  }

  private applyNodePromoted(model: ProjectModel, event: StoredEvent & { type: 'NODE_PROMOTED' }): void {
    // Find the node across all maps
    const decision = model.decisions.get(event.nodeId)
    if (decision) {
      decision.commitment = event.to
      decision.promotionHistory.push({
        from: event.from,
        to: event.to,
        trigger: event.trigger,
        wasAutomatic: event.wasAutomatic,
        sessionId: event.sessionId,
        turnIndex: event.turnIndex,
        promotedAt: event.storedAt,
      })
    }
  }

  private applyNodeRejected(model: ProjectModel, nodeId: NodeId, nodeType: ModelNodeType, reason: string, provenance: unknown): void {
    // Move node from its current map to rejections if it was a decision
    if (nodeType === 'decision') {
      const decision = model.decisions.get(nodeId)
      if (decision) {
        model.decisions.delete(nodeId)
        // The rejection node itself should be created via a separate NODE_CREATED event
      }
    }
    // For explorations, mark as abandoned
    if (nodeType === 'exploration') {
      const exploration = model.explorations.get(nodeId)
      if (exploration) {
        exploration.status = 'abandoned'
      }
    }
  }

  private applyCorrectionToModel(model: ProjectModel, nodeId: NodeId, changes: Record<string, unknown>): void {
    // Try all maps to find and update the node
    for (const mapName of ['decisions', 'constraints', 'rejections', 'explorations', 'tensions', 'artifacts'] as const) {
      const map = model[mapName] as Map<NodeId, unknown>
      const node = map.get(nodeId)
      if (node) {
        Object.assign(node as Record<string, unknown>, changes)
        return
      }
    }
  }

  private getMapForType(model: ProjectModel, nodeType: ModelNodeType): Map<NodeId, unknown> | null {
    switch (nodeType) {
      case 'decision': return model.decisions as Map<NodeId, unknown>
      case 'constraint': return model.constraints as Map<NodeId, unknown>
      case 'rejection': return model.rejections as Map<NodeId, unknown>
      case 'exploration': return model.explorations as Map<NodeId, unknown>
      case 'tension': return model.tensions as Map<NodeId, unknown>
      case 'artifact': return model.artifacts as Map<NodeId, unknown>
      default: return null
    }
  }

  private eventToModelChange(event: StoredEvent): ModelChange | null {
    switch (event.type) {
      case 'NODE_CREATED':
        return {
          nodeId: (event.node as { id: NodeId }).id,
          nodeType: event.nodeType,
          changeType: 'created',
          newValue: event.node,
          turnIndex: event.turnIndex,
        }
      case 'NODE_UPDATED':
        return {
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          changeType: 'updated',
          newValue: event.changes,
          turnIndex: event.turnIndex,
        }
      case 'NODE_PROMOTED':
        return {
          nodeId: event.nodeId,
          nodeType: 'decision',
          changeType: 'promoted',
          previousValue: event.from,
          newValue: event.to,
          turnIndex: event.turnIndex,
        }
      default:
        return null
    }
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  private serializeModel(model: ProjectModel): string {
    return JSON.stringify(model, (_, value) => {
      if (value instanceof Map) {
        return { __type: 'Map', entries: Array.from(value.entries()) }
      }
      return value
    })
  }

  private deserializeModel(json: string): ProjectModel {
    return JSON.parse(json, (_, value) => {
      if (value && typeof value === 'object' && value.__type === 'Map') {
        return new Map(value.entries)
      }
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return new Date(value)
      }
      return value
    })
  }

  private rowToStoredEvent(row: EventRow): StoredEvent {
    const payload = JSON.parse(row.payload, (_, value) => {
      if (value && typeof value === 'object' && value.__type === 'Map') {
        return new Map(value.entries)
      }
      return value
    })
    return {
      ...payload,
      type: row.type,
      eventId: row.event_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      storedAt: new Date(row.stored_at),
    }
  }

  private rowToStoredTurn(row: TurnRow): StoredTurn {
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      turnIndex: row.turn_index,
      speaker: row.speaker as 'user' | 'system',
      text: row.text,
      timestamp: new Date(row.timestamp),
      classification: row.classification ? JSON.parse(row.classification) : undefined,
      extractionResult: row.extraction_result ? JSON.parse(row.extraction_result) : undefined,
    }
  }

  // ── Surfacing (Trust Calibration) ─────────────────────────────────────────

  recordSurfacing(event: {
    type: SurfacingType
    sessionId: string
    projectId: NodeId
    turnIndex: number
    targetNodeIds: NodeId[]
    message: string
  }): SurfacingEvent {
    const id = nanoid(10)
    const surfacedAt = new Date()

    this.db.prepare(`
      INSERT INTO surfacing_events (id, type, session_id, project_id, turn_index, surfaced_at, target_node_ids, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, event.type, event.sessionId, event.projectId, event.turnIndex, surfacedAt.toISOString(), JSON.stringify(event.targetNodeIds), event.message)

    return {
      id,
      type: event.type,
      sessionId: event.sessionId,
      turnIndex: event.turnIndex,
      surfacedAt,
      targetNodeIds: event.targetNodeIds,
      message: event.message,
      wasAcknowledged: false,
    }
  }

  acknowledgeSurfacing(id: string, response?: string, helpful?: boolean): void {
    this.db.prepare(`
      UPDATE surfacing_events SET was_acknowledged = 1, user_response = ?, was_helpful = ?
      WHERE id = ?
    `).run(response ?? null, helpful != null ? (helpful ? 1 : 0) : null, id)
  }

  getSessionSurfacings(sessionId: string): SurfacingEvent[] {
    const rows = this.db.prepare(`
      SELECT id, type, session_id, turn_index, surfaced_at, target_node_ids, message, was_acknowledged, user_response, was_helpful
      FROM surfacing_events WHERE session_id = ? ORDER BY surfaced_at
    `).all(sessionId) as SurfacingRow[]

    return rows.map(this.rowToSurfacingEvent)
  }

  getRecentSurfacings(projectId: NodeId, limit: number = 20): SurfacingEvent[] {
    const rows = this.db.prepare(`
      SELECT id, type, session_id, turn_index, surfaced_at, target_node_ids, message, was_acknowledged, user_response, was_helpful
      FROM surfacing_events WHERE project_id = ? ORDER BY surfaced_at DESC LIMIT ?
    `).all(projectId, limit) as SurfacingRow[]

    return rows.map(this.rowToSurfacingEvent)
  }

  hasSurfacedForNodes(sessionId: string, type: SurfacingType, nodeIds: NodeId[]): boolean {
    const rows = this.db.prepare(`
      SELECT target_node_ids FROM surfacing_events
      WHERE session_id = ? AND type = ?
    `).all(sessionId, type) as { target_node_ids: string }[]

    for (const row of rows) {
      const surfacedIds: NodeId[] = JSON.parse(row.target_node_ids)
      if (nodeIds.some(id => surfacedIds.includes(id))) return true
    }
    return false
  }

  getTrustMetrics(sessionId: string): TrustMetrics {
    const surfacings = this.getSessionSurfacings(sessionId)

    return {
      sessionId,
      totalSurfacings: surfacings.length,
      acknowledgedSurfacings: surfacings.filter(s => s.wasAcknowledged).length,
      ignoredSurfacings: surfacings.filter(s => !s.wasAcknowledged).length,
      correctionsThisSession: this.countCorrections(sessionId),
      falseEscalations: surfacings.filter(s => s.type === 'escalation' && s.wasAcknowledged && s.wasHelpful === false).length,
      helpfulSurfacings: surfacings.filter(s => s.wasHelpful === true).length,
      flowInterruptions: 0, // Calculated by trust engine, not stored
      suppressedSurfacings: 0, // Tracked in-memory by trust engine
    }
  }

  private countCorrections(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE session_id = ? AND type = 'CORRECTION_APPLIED'
    `).get(sessionId) as { count: number }
    return row.count
  }

  private rowToSurfacingEvent(row: SurfacingRow): SurfacingEvent {
    return {
      id: row.id,
      type: row.type as SurfacingType,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      surfacedAt: new Date(row.surfaced_at),
      targetNodeIds: JSON.parse(row.target_node_ids),
      message: row.message,
      wasAcknowledged: row.was_acknowledged === 1,
      userResponse: row.user_response ?? undefined,
      wasHelpful: row.was_helpful != null ? row.was_helpful === 1 : undefined,
    }
  }

  close(): void {
    this.db.close()
  }
}

// ── Row types for SQLite results ─────────────────────────────────────────────

type EventRow = {
  event_id: string
  project_id: string
  session_id: string
  turn_index: number
  type: string
  payload: string
  stored_at: string
}

type TurnRow = {
  turn_id: string
  session_id: string
  project_id: string
  turn_index: number
  speaker: string
  text: string
  timestamp: string
  classification: string | null
  extraction_result: string | null
}

type SurfacingRow = {
  id: string
  type: string
  session_id: string
  turn_index: number
  surfaced_at: string
  target_node_ids: string
  message: string
  was_acknowledged: number
  user_response: string | null
  was_helpful: number | null
}

type WorkspaceRow = {
  workspace_id: string
  name: string
  created_at: string
  updated_at: string
  values_model: string
  risk_profile: string
  cortex_config: string | null
}
