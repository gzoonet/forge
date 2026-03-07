import { ProjectModelStore } from '@gzoo/forge-store'
import { ExtractionPipeline, createLLMClient, resolveProviderConfig } from '@gzoo/forge-extract'
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

  // Display constraint propagation results
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

  console.log(`\n═══ Session Brief ═══\n`)

  // Primary goal
  if (m.intent.primaryGoal) {
    console.log(`Goal: ${m.intent.primaryGoal.statement}`)
  } else {
    console.log('Goal: Not yet defined')
  }

  // Decision summary by commitment
  const locked = getDecisionsByCommitment(m, 'locked')
  const decided = getDecisionsByCommitment(m, 'decided')
  const leaning = getDecisionsByCommitment(m, 'leaning')

  if (locked.length > 0) {
    console.log(`\nLocked (${locked.length}):`)
    for (const d of locked) console.log(`  🔒 ${d.statement}`)
  }

  if (decided.length > 0) {
    console.log(`\nDecided (${decided.length}):`)
    for (const d of decided) console.log(`  ✓ ${d.statement}`)
  }

  if (leaning.length > 0) {
    console.log(`\nLeaning (${leaning.length}):`)
    for (const d of leaning) console.log(`  → ${d.statement}`)
  }

  // Active explorations
  const activeExp = getActiveExplorations(m)
  if (activeExp.length > 0) {
    console.log(`\nOpen explorations (${activeExp.length}):`)
    for (const e of activeExp) {
      console.log(`  ? ${e.topic}`)
    }
  }

  // Unresolved tensions
  const tensions = getUnresolvedTensions(m)
  if (tensions.length > 0) {
    console.log(`\nUnresolved tensions (${tensions.length}):`)
    for (const t of tensions) {
      console.log(`  ⚠ ${t.description} [${t.severity}]`)
    }
  }

  // Constraints
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
