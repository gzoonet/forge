import { ProjectModelStore } from '@gzoo/forge-store'
import { ExtractionPipeline, TrustEngine, createLLMClient, resolveProviderConfig, generateSessionBrief } from '@gzoo/forge-extract'
import type { LLMClient } from '@gzoo/forge-extract'
import type {
  ConversationalTurn,
  Decision,
  Constraint,
  Rejection,
  Exploration,
  Tension,
  CommitmentLevel,
} from '@gzoo/forge-core'
import { getDecisionsByCommitment, getActiveExplorations, getUnresolvedTensions } from '@gzoo/forge-store'
import { ExecutionEngine, GitHubHook } from '@gzoo/forge-execute'
import { loadState, saveState, getDbPath, ensureStateDir, type ForgeState } from './state'

function getStore(state?: ForgeState | null): ProjectModelStore {
  const s = state ?? loadState()
  if (!s) throw new Error('No active project. Run: forge init "Project name"')
  return new ProjectModelStore(s.dbPath)
}

function getLLMClient(): LLMClient {
  try {
    const config = resolveProviderConfig()
    return createLLMClient(config)
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    console.error('See .env.example for configuration options.')
    process.exit(1)
  }
}

// ── forge init ───────────────────────────────────────────────────────────────

export function init(name: string): void {
  ensureStateDir()
  const dbPath = getDbPath()
  const store = new ProjectModelStore(dbPath)
  const projectId = store.createProject('ws_default', name)
  const sessionId = store.startSession(projectId)

  const state: ForgeState = {
    projectId,
    sessionId,
    turnIndex: 0,
    dbPath,
  }
  saveState(state)
  store.close()

  console.log(`Project initialized: "${name}"`)
  console.log(`  Project ID: ${projectId}`)
  console.log(`  Session ID: ${sessionId}`)
  console.log(`  Database:   ${dbPath}`)
  console.log('')
  console.log('Start adding turns with: forge turn "your text here"')
}

// ── forge turn ───────────────────────────────────────────────────────────────

export async function turn(text: string): Promise<void> {
  const state = loadState()
  if (!state) {
    console.error('No active project. Run: forge init "Project name"')
    return
  }

  state.turnIndex++
  const store = new ProjectModelStore(state.dbPath)
  const llm = getLLMClient()
  const pipeline = new ExtractionPipeline(store, llm)
  pipeline.initTrust(state.projectId, state.sessionId)

  const conversationalTurn: ConversationalTurn = {
    sessionId: state.sessionId,
    turnIndex: state.turnIndex,
    speaker: 'user',
    text,
    timestamp: new Date(),
  }

  console.log(`Processing turn ${state.turnIndex}...`)
  const result = await pipeline.processTurn(conversationalTurn, state.projectId)

  // Display results
  const classification = result.classifications[0]
  console.log(`  Classification: ${classification.type} (${classification.confidence})`)
  if (classification.additionalTypes?.length) {
    console.log(`  Additional:     ${classification.additionalTypes.join(', ')}`)
  }

  if (result.modelUpdates.length > 0) {
    console.log(`  Model updates:  ${result.modelUpdates.length}`)
    for (const update of result.modelUpdates) {
      console.log(`    ${update.operation} → ${update.targetLayer}`)
    }
  } else {
    console.log('  No model updates (no-op turn)')
  }

  if (result.extractionFailures && result.extractionFailures > 0) {
    console.log(`  ⚠ ${result.extractionFailures} extraction${result.extractionFailures > 1 ? 's' : ''} failed (check logs)`)
  }

  if (result.promotionChecks.length > 0) {
    for (const check of result.promotionChecks) {
      if (check.requiresUserAction) {
        console.log(`  ⚡ Promotion suggestion: ${check.nodeId} could move from ${check.currentCommitment} → ${check.candidatePromotion}`)
        console.log('     (requires your explicit commitment)')
      } else {
        console.log(`  Auto-promoted: ${check.nodeId} → ${check.candidatePromotion}`)
      }
    }
  }

  // Display cross-project memory matches
  if (result.memoryMatches && result.memoryMatches.length > 0) {
    console.log('')
    console.log(`  Cross-project memory (${result.memoryMatches.length} match${result.memoryMatches.length > 1 ? 'es' : ''}):`)
    for (const match of result.memoryMatches.slice(0, 3)) {
      const icon = match.nodeType === 'rejection' ? '✗' : '·'
      console.log(`    ${icon} [${match.projectName}] ${match.statement}`)
      if (match.outcome) console.log(`      ${match.outcome}`)
    }
    if (result.memoryMatches.length > 3) {
      console.log(`    ... and ${result.memoryMatches.length - 3} more (run: forge memory "...")`)
    }
  }

  // Display trust-calibrated surfacings
  if (result.surfacingDecisions && result.surfacingDecisions.length > 0) {
    const surfaced = result.surfacingDecisions.filter(s => s.shouldSurface)
    const suppressed = result.surfacingDecisions.filter(s => !s.shouldSurface)

    for (const s of surfaced) {
      console.log('')
      const icon = s.priority === 'critical' ? '!!!' :
                   s.priority === 'high' ? '!! ' :
                   s.priority === 'medium' ? '!  ' : '   '
      console.log(`  [${icon}] ${s.suggestedMessage ?? s.reason}`)
    }

    if (suppressed.length > 0) {
      // Show suppression count but not details — trust engine working quietly
      const trustEngine = pipeline.getTrustEngine()
      if (trustEngine?.getFlowState().isInFlow) {
        // Don't even mention suppressions during flow
      } else {
        console.log(`  (${suppressed.length} notification${suppressed.length > 1 ? 's' : ''} suppressed)`)
      }
    }
  } else {
    // Fallback for when trust engine isn't active
    if (result.escalationRequired) {
      console.log('')
      console.log(`  ⚠ CONSTRAINT CONFLICT DETECTED`)
      if (result.escalationReason) {
        console.log(`    ${result.escalationReason}`)
      }
      console.log('    Run: forge tensions  — to see details')
    } else if (result.conflictChecksTriggered) {
      const tensionUpdates = result.modelUpdates.filter(u => u.targetLayer === 'tensions')
      if (tensionUpdates.length > 0) {
        console.log(`  Tensions detected: ${tensionUpdates.length} (run: forge tensions)`)
      }
    }
  }

  saveState(state)
  store.close()
}

// ── forge model ──────────────────────────────────────────────────────────────

export function model(): void {
  const state = loadState()
  const store = getStore(state)
  const m = store.getProjectModel(state!.projectId)

  console.log(`\n═══ Project Model: ${m.name} ═══`)
  console.log(`Version: ${m.version} | Sessions: ${m.sessionIds.length}`)

  // Intent
  if (m.intent.primaryGoal) {
    console.log(`\n── Intent ──`)
    console.log(`  Goal: ${m.intent.primaryGoal.statement}`)
    console.log(`  Commitment: ${m.intent.primaryGoal.commitment}`)
    if (m.intent.primaryGoal.successCriteria.length > 0) {
      console.log(`  Success criteria:`)
      for (const c of m.intent.primaryGoal.successCriteria) {
        console.log(`    • ${c}`)
      }
    }
  }

  // Decisions
  if (m.decisions.size > 0) {
    console.log(`\n── Decisions (${m.decisions.size}) ──`)
    for (const [, dec] of m.decisions) {
      printDecision(dec)
    }
  }

  // Constraints
  if (m.constraints.size > 0) {
    console.log(`\n── Constraints (${m.constraints.size}) ──`)
    for (const [, con] of m.constraints) {
      console.log(`  [${con.hardness}] ${con.statement}`)
      console.log(`    Type: ${con.type} | Source: ${con.source}`)
    }
  }

  // Rejections
  if (m.rejections.size > 0) {
    console.log(`\n── Rejections (${m.rejections.size}) ──`)
    for (const [, rej] of m.rejections) {
      console.log(`  ✗ ${rej.statement}`)
      console.log(`    Type: ${rej.rejectionType} | Reason: ${rej.reason}`)
      if (rej.revealsPreference) {
        console.log(`    Reveals: ${rej.revealsPreference}`)
      }
    }
  }

  // Explorations
  if (m.explorations.size > 0) {
    console.log(`\n── Explorations (${m.explorations.size}) ──`)
    for (const [, exp] of m.explorations) {
      console.log(`  ? ${exp.topic} [${exp.status}]`)
      console.log(`    Direction: ${exp.direction}`)
      if (exp.openQuestions.length > 0) {
        for (const q of exp.openQuestions) {
          console.log(`    • ${q}`)
        }
      }
    }
  }

  // Tensions
  if (m.tensions.size > 0) {
    console.log(`\n── Tensions (${m.tensions.size}) ──`)
    for (const [, ten] of m.tensions) {
      console.log(`  ⚠ ${ten.description} [${ten.severity}]`)
    }
  }

  console.log('')
  store.close()
}

function printDecision(dec: Decision): void {
  const icon = commitmentIcon(dec.commitment)
  console.log(`  ${icon} ${dec.statement}`)
  console.log(`    ${dec.commitment} | ${dec.category} | certainty: ${dec.certainty}`)
  if (dec.rationale && dec.rationale !== 'Not stated') {
    console.log(`    Rationale: ${dec.rationale}`)
  }
  if (dec.alternatives.length > 0) {
    console.log(`    Alternatives: ${dec.alternatives.join(', ')}`)
  }
}

function commitmentIcon(level: CommitmentLevel): string {
  switch (level) {
    case 'exploring': return '~'
    case 'leaning': return '→'
    case 'decided': return '✓'
    case 'locked': return '🔒'
  }
}

// ── forge events ─────────────────────────────────────────────────────────────

export function events(): void {
  const state = loadState()
  const store = getStore(state)
  const allEvents = store.getAllEvents(state!.projectId)

  console.log(`\n═══ Event Log (${allEvents.length} events) ═══\n`)

  for (const event of allEvents) {
    const time = event.storedAt.toISOString().slice(11, 19)
    console.log(`  [${time}] ${event.type}`)

    switch (event.type) {
      case 'PROJECT_CREATED':
        console.log(`    Name: ${event.name}`)
        break
      case 'SESSION_STARTED':
        console.log(`    Session: ${event.sessionId}`)
        break
      case 'NODE_CREATED':
        console.log(`    Type: ${event.nodeType} | ID: ${(event.node as any).id}`)
        break
      case 'NODE_PROMOTED':
        console.log(`    ${event.from} → ${event.to} (${event.trigger})`)
        break
      case 'INTENT_UPDATED':
        console.log(`    Field: ${event.field}`)
        break
      case 'CORRECTION_APPLIED':
        console.log(`    Target: ${event.targetNodeId}`)
        break
    }
  }

  console.log('')
  store.close()
}

// ── forge brief ──────────────────────────────────────────────────────────────

export function brief(): void {
  const state = loadState()
  const store = getStore(state)
  const m = store.getProjectModel(state!.projectId)

  const sb = generateSessionBrief(m, store, state!.sessionId)

  console.log(`\n═══ Session Brief ═══\n`)
  console.log(`Goal: ${sb.primaryGoal}`)

  if (sb.lockedDecisions.length > 0) {
    console.log(`\nLocked (${sb.lockedDecisions.length}):`)
    for (const d of sb.lockedDecisions) console.log(`  🔒 ${d.statement}`)
  }

  if (sb.decidedDecisions.length > 0) {
    console.log(`\nDecided (${sb.decidedDecisions.length}):`)
    for (const d of sb.decidedDecisions) console.log(`  ✓ ${d.statement}`)
  }

  if (sb.pendingDecisions.length > 0) {
    console.log(`\nPending (${sb.pendingDecisions.length}):`)
    for (const p of sb.pendingDecisions) {
      console.log(`  ? ${p.topic}`)
      for (const q of p.openQuestions) {
        console.log(`    • ${q}`)
      }
    }
  }

  if (sb.unresolvedTensions.length > 0) {
    console.log(`\nUnresolved tensions (${sb.unresolvedTensions.length}):`)
    for (const t of sb.unresolvedTensions) {
      console.log(`  ⚠ ${t.description} [${t.severity}]`)
    }
  }

  if (sb.artifactsInProgress.length > 0) {
    console.log(`\nArtifacts in progress (${sb.artifactsInProgress.length}):`)
    for (const a of sb.artifactsInProgress) {
      console.log(`  [${a.status}] ${a.name} (${a.sectionsCommitted}/${a.sectionsInProgress + a.sectionsCommitted} sections)`)
    }
  }

  if (sb.changesSinceLastSession.length > 0) {
    console.log(`\nChanges since last session:`)
    for (const c of sb.changesSinceLastSession) {
      console.log(`  • ${c}`)
    }
  }

  // Constraints (still show these from model directly)
  if (m.constraints.size > 0) {
    console.log(`\nConstraints (${m.constraints.size}):`)
    for (const [, c] of m.constraints) {
      console.log(`  [${c.hardness}] ${c.statement}`)
    }
  }

  // Rejections
  if (m.rejections.size > 0) {
    console.log(`\nRejections (${m.rejections.size}):`)
    for (const [, r] of m.rejections) {
      console.log(`  ✗ ${r.statement}`)
    }
  }

  console.log(`\nSession turns: ${state!.turnIndex}`)
  console.log(`Outcome: ${sb.lastSessionOutcome}`)
  console.log('')
  store.close()
}

// ── forge artifacts ──────────────────────────────────────────────────────────

export function artifacts(): void {
  const state = loadState()
  const store = getStore(state)
  const m = store.getProjectModel(state!.projectId)

  if (m.artifacts.size === 0) {
    console.log('\nNo artifacts generated yet.')
    console.log('Artifacts auto-generate after 3+ committed decisions.\n')
    store.close()
    return
  }

  for (const [, art] of m.artifacts) {
    console.log(`\n═══ ${art.name} ═══`)
    console.log(`Type: ${art.type} | Status: ${art.status} | Version: ${art.version}`)
    console.log(`Decisions: ${art.sourceDecisionIds.length} | Constraints: ${art.sourceConstraintIds.length}`)
    console.log('')

    // Print the root section content (full spec)
    const root = art.sections.get(art.rootSectionId)
    if (root) {
      console.log(root.content.body)
    }

    // List sub-sections
    if (root && root.childSectionIds.length > 0) {
      console.log(`\n── Sections (${root.childSectionIds.length}) ──`)
      for (const secId of root.childSectionIds) {
        const sec = art.sections.get(secId)
        if (sec) {
          console.log(`  [${sec.status}] ${sec.title} (v${sec.version})`)
        }
      }
    }
  }

  console.log('')
  store.close()
}

// ── forge tensions ──────────────────────────────────────────────────────────

export function tensions(): void {
  const state = loadState()
  const store = getStore(state)
  const m = store.getProjectModel(state!.projectId)

  const allTensions = Array.from(m.tensions.values())
  const active = allTensions.filter(t => t.status === 'active')
  const resolved = allTensions.filter(t => t.status === 'resolved')
  const acknowledged = allTensions.filter(t => t.status === 'acknowledged')

  console.log(`\n═══ Constraint Tensions ═══\n`)

  if (active.length === 0 && acknowledged.length === 0) {
    console.log('No active tensions.')
    if (resolved.length > 0) {
      console.log(`(${resolved.length} resolved tension${resolved.length > 1 ? 's' : ''} in history)`)
    }
    console.log('')
    store.close()
    return
  }

  if (active.length > 0) {
    console.log(`Active (${active.length}):`)
    for (const t of active) {
      const icon = t.severity === 'blocking' ? '!!!' :
                   t.severity === 'significant' ? '!! ' : 'i  '
      console.log(`  [${icon}] ${t.description}`)
      console.log(`    Between: ${t.nodeAId} <-> ${t.nodeBId}`)
      console.log(`    Severity: ${t.severity}`)

      // Try to show what the conflicting nodes actually are
      const nodeA = findNodeStatement(m, t.nodeAId)
      const nodeB = findNodeStatement(m, t.nodeBId)
      if (nodeA) console.log(`    Node A: ${nodeA}`)
      if (nodeB) console.log(`    Node B: ${nodeB}`)
      console.log('')
    }
  }

  if (acknowledged.length > 0) {
    console.log(`Acknowledged (${acknowledged.length}):`)
    for (const t of acknowledged) {
      console.log(`  [ack] ${t.description}`)
    }
    console.log('')
  }

  if (resolved.length > 0) {
    console.log(`Resolved (${resolved.length}):`)
    for (const t of resolved) {
      console.log(`  [done] ${t.description}`)
      if (t.resolution) console.log(`    Resolution: ${t.resolution}`)
    }
    console.log('')
  }

  store.close()
}

function findNodeStatement(m: any, nodeId: string): string | null {
  const decision = m.decisions.get(nodeId)
  if (decision) return `[decision] ${decision.statement}`
  const constraint = m.constraints.get(nodeId)
  if (constraint) return `[constraint] ${constraint.statement}`
  const exploration = m.explorations.get(nodeId)
  if (exploration) return `[exploration] ${exploration.topic}`
  return null
}

// ── forge actions ───────────────────────────────────────────────────────────

function getExecutionEngine(state: ForgeState): ExecutionEngine {
  const store = new ProjectModelStore(state.dbPath)
  const engine = new ExecutionEngine(store, state.projectId)

  // Register available hooks
  const githubHook = new GitHubHook()
  engine.registerHook(githubHook)

  return engine
}

export async function actions(): Promise<void> {
  const state = loadState()
  if (!state) {
    console.error('No active project. Run: forge init "Project name"')
    return
  }

  const store = new ProjectModelStore(state.dbPath)
  const engine = new ExecutionEngine(store, state.projectId)
  const githubHook = new GitHubHook()
  engine.registerHook(githubHook)

  const model = store.getProjectModel(state.projectId)
  const proposals = await engine.proposeActions(model)

  console.log(`\n=== Proposed Actions ===\n`)

  if (proposals.length === 0) {
    console.log('No actions to propose.')
    const hooks = engine.getRegisteredHooks()
    if (hooks.length === 0) {
      console.log('No execution hooks configured.')
    } else {
      const configured = hooks.filter(() => githubHook.isConfigured())
      console.log(`Hooks: ${hooks.join(', ')} (${configured.length} configured)`)
      if (!githubHook.isConfigured()) {
        console.log('\nTo enable GitHub: set GITHUB_TOKEN and GITHUB_OWNER in .env')
      }
    }
    console.log('')
    store.close()
    return
  }

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i]
    const action = engine.createAction(p)
    console.log(`  [${i + 1}] ${p.description}`)
    console.log(`      Service: ${p.service} | Type: ${p.actionType}`)
    console.log(`      Reason: ${p.reason}`)
    console.log(`      Action ID: ${action.id}`)
    if (p.requiresApproval) {
      console.log(`      Requires approval: yes`)
    }
    console.log('')
  }

  console.log(`Use: forge execute <action-id>  — to approve and execute an action`)
  console.log('')
  store.close()
}

export async function execute(actionId: string): Promise<void> {
  const state = loadState()
  if (!state) {
    console.error('No active project. Run: forge init "Project name"')
    return
  }

  if (!actionId) {
    console.error('Usage: forge execute <action-id>')
    console.error('Run: forge actions  — to see available actions')
    return
  }

  const store = new ProjectModelStore(state.dbPath)
  const engine = new ExecutionEngine(store, state.projectId)
  const githubHook = new GitHubHook()
  engine.registerHook(githubHook)

  // We need to re-propose to get the action registered
  const model = store.getProjectModel(state.projectId)
  const proposals = await engine.proposeActions(model)

  // Create all actions so the requested one exists
  for (const p of proposals) {
    engine.createAction(p)
  }

  const action = engine.getAction(actionId)
  if (!action) {
    console.error(`Action not found: ${actionId}`)
    console.error('Run: forge actions  — to see available actions with their IDs')
    store.close()
    return
  }

  console.log(`\nExecuting: ${action.description}`)
  console.log(`  Service: ${action.service} | Type: ${action.actionType}`)

  const result = await engine.approveAndExecute(actionId, state.sessionId)

  if (result.success) {
    console.log(`  Status: SUCCESS`)
    if (result.data) {
      for (const [key, value] of Object.entries(result.data)) {
        console.log(`  ${key}: ${value}`)
      }
    }
  } else {
    console.log(`  Status: FAILED`)
    console.log(`  Error: ${result.error}`)
  }

  console.log('')
  store.close()
}

// ── forge trust ──────────────────────────────────────────────────────────────

export function trust(): void {
  const state = loadState()
  const store = getStore(state)

  console.log(`\n═══ Trust Calibration ═══\n`)

  // Get surfacing history for current session
  const surfacings = store.getSessionSurfacings(state!.sessionId)
  const metrics = store.getTrustMetrics(state!.sessionId)

  // Metrics summary
  console.log('── Session Metrics ──')
  console.log(`  Total surfacings:      ${metrics.totalSurfacings}`)
  console.log(`  Acknowledged:          ${metrics.acknowledgedSurfacings}`)
  console.log(`  Ignored:               ${metrics.ignoredSurfacings}`)
  console.log(`  Corrections:           ${metrics.correctionsThisSession}`)
  if (metrics.falseEscalations > 0) {
    console.log(`  False escalations:     ${metrics.falseEscalations}`)
  }
  if (metrics.helpfulSurfacings > 0) {
    console.log(`  Helpful:               ${metrics.helpfulSurfacings}`)
  }

  // Acknowledgment rate
  if (metrics.totalSurfacings > 0) {
    const ackRate = Math.round((metrics.acknowledgedSurfacings / metrics.totalSurfacings) * 100)
    console.log(`  Acknowledgment rate:   ${ackRate}%`)
    if (ackRate < 50) {
      console.log('  → Low ack rate suggests over-interrupting. Consider raising thresholds.')
    }
  }

  // Surfacing history
  if (surfacings.length > 0) {
    console.log(`\n── Surfacing History ──`)
    for (const s of surfacings) {
      const ack = s.wasAcknowledged ? '✓' : '○'
      const time = s.surfacedAt.toISOString().slice(11, 19)
      console.log(`  [${time}] ${ack} [${s.type}] ${s.message.slice(0, 80)}`)
      if (s.userResponse) {
        console.log(`    Response: ${s.userResponse}`)
      }
    }
  }

  // Correction frequency (extraction quality signal)
  if (metrics.correctionsThisSession > 0) {
    const turns = state!.turnIndex
    const correctionRate = Math.round((metrics.correctionsThisSession / Math.max(turns, 1)) * 100)
    console.log(`\n── Extraction Quality ──`)
    console.log(`  Corrections: ${metrics.correctionsThisSession} in ${turns} turns (${correctionRate}%)`)
    if (correctionRate > 20) {
      console.log('  → High correction rate suggests extraction needs tuning.')
    }
  }

  console.log('')
  store.close()
}

// ── forge workspace ──────────────────────────────────────────────────────────

export function workspace(): void {
  const state = loadState()
  const store = getStore(state)

  // Find the workspace for the current project
  const m = store.getProjectModel(state!.projectId)
  const ws = store.getWorkspace(m.workspaceId || 'ws_default')

  if (!ws) {
    console.log('\nNo workspace found.')
    store.close()
    return
  }

  console.log(`\n═══ Workspace: ${ws.name} ═══`)
  console.log(`  ID: ${ws.id}`)
  console.log(`  Projects: ${ws.projectIds.length}`)

  // Values model
  if (ws.valuesModel.inferredPreferences.length > 0) {
    console.log(`\n── Inferred Preferences (${ws.valuesModel.inferredPreferences.length}) ──`)
    for (const pref of ws.valuesModel.inferredPreferences) {
      console.log(`  [${pref.confidence}] ${pref.statement}`)
      console.log(`    Evidence: ${pref.evidenceCount} rejection${pref.evidenceCount > 1 ? 's' : ''} across ${pref.sourceProjectIds.length} project${pref.sourceProjectIds.length > 1 ? 's' : ''}`)
    }
  } else {
    console.log('\n  No inferred preferences yet (builds from categorical rejections)')
  }

  // Risk profile
  console.log(`\n── Risk Profile ──`)
  console.log(`  Technical:  ${ws.riskProfile.technical}`)
  console.log(`  Market:     ${ws.riskProfile.market}`)
  console.log(`  Financial:  ${ws.riskProfile.financial}`)

  console.log('')
  store.close()
}

// ── forge workspace:rebuild ─────────────────────────────────────────────────

export function workspaceRebuild(): void {
  const state = loadState()
  const store = getStore(state)
  const m = store.getProjectModel(state!.projectId)
  const workspaceId = m.workspaceId || 'ws_default'

  console.log('Rebuilding workspace values model...')
  const values = store.buildValuesModel(workspaceId)
  console.log(`  Inferred preferences: ${values.inferredPreferences.length}`)

  console.log('Inferring risk profile...')
  const risk = store.inferRiskProfile(workspaceId)
  console.log(`  Technical: ${risk.technical} | Market: ${risk.market} | Financial: ${risk.financial}`)

  console.log('\nDone.')
  store.close()
}

// ── forge memory ─────────────────────────────────────────────────────────────

export async function memory(queryText: string): Promise<void> {
  const state = loadState()
  if (!state) {
    console.error('No active project. Run: forge init "Project name"')
    return
  }

  const store = new ProjectModelStore(state.dbPath)

  console.log(`Querying cross-project memory for: "${queryText}"`)
  const result = store.queryMemory({
    currentDecision: queryText,
    excludeProjectId: state.projectId,
  })

  if (result.matches.length === 0) {
    console.log('\nNo relevant matches found across other projects.')
    console.log(`(Query time: ${result.queryTime}ms)`)
    store.close()
    return
  }

  console.log(`\n═══ Memory Matches (${result.matches.length}) ═══\n`)

  for (const match of result.matches) {
    const icon = match.nodeType === 'rejection' ? '✗' :
                 match.nodeType === 'decision' ? '✓' :
                 match.nodeType === 'exploration' ? '?' : '·'
    console.log(`  ${icon} [${match.nodeType}] ${match.statement}`)
    console.log(`    Project: ${match.projectName} | Relevance: ${match.relevanceScore}%`)
    if (match.outcome) {
      console.log(`    Outcome: ${match.outcome}`)
    }
    console.log(`    ${match.matchReason}`)
    console.log('')
  }

  console.log(`Query time: ${result.queryTime}ms | Source: ${result.source}`)
  store.close()
}

// ── forge test ───────────────────────────────────────────────────────────────

export function test(): void {
  console.log('Running behavioral contract tests...')
  console.log('Use: npx vitest run  (from packages/core, packages/store, or packages/extract)')
  console.log('')
  console.log('Or run all tests from the monorepo root:')
  console.log('  cd packages/core && npx vitest run')
  console.log('  cd packages/store && npx vitest run')
  console.log('  cd packages/extract && npx vitest run')
}
