import * as fs from 'fs'
import * as path from 'path'
import { ProjectModelStore } from '@gzoo/forge-store'
import { ExtractionPipeline, createLLMClient, resolveProviderConfig } from '@gzoo/forge-extract'
import type { LLMClient } from '@gzoo/forge-extract'
import type { NodeId, ConversationalTurn, ExtractionResult, ProjectModel, SessionBrief } from '@gzoo/forge-core'
import { generateSessionBrief } from '@gzoo/forge-extract'

// ─── State Persistence ──────────────────────────────────────────────────────

const STATE_DIR = path.join(process.cwd(), '.forge')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

type ForgeState = {
  projectId: string
  sessionId: string
  turnIndex: number
  dbPath: string
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  }
}

function saveState(state: ForgeState): void {
  ensureStateDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function loadState(): ForgeState | null {
  if (!fs.existsSync(STATE_FILE)) return null
  const raw = fs.readFileSync(STATE_FILE, 'utf-8')
  return JSON.parse(raw)
}

function getDbPath(): string {
  return path.join(STATE_DIR, 'forge.db')
}

// ─── ForgeServer ────────────────────────────────────────────────────────────

export class ForgeServer {
  private store: ProjectModelStore | null = null
  private pipeline: ExtractionPipeline | null = null
  private llmClient: LLMClient | null = null
  private projectId: string | null = null
  private sessionId: string | null = null
  private turnIndex: number = 0
  private previousSessionId: string | undefined = undefined

  /**
   * Try to resume from existing .forge/state.json.
   * Returns true if a project was loaded, false if forge_init is needed.
   */
  tryResume(): boolean {
    const state = loadState()
    if (!state) return false

    try {
      this.store = new ProjectModelStore(state.dbPath)
      this.projectId = state.projectId
      this.previousSessionId = state.sessionId
      this.turnIndex = 0

      // Start a fresh session for this MCP connection
      this.sessionId = this.store.startSession(this.projectId)
      this.initPipeline()
      this.saveCurrentState()
      return true
    } catch {
      this.store = null
      this.projectId = null
      this.sessionId = null
      return false
    }
  }

  /**
   * Initialize a new project. Called by forge_init tool.
   */
  initProject(name: string): { projectId: string; sessionId: string; dbPath: string } {
    ensureStateDir()
    const dbPath = getDbPath()

    this.store = new ProjectModelStore(dbPath)
    this.projectId = this.store.createProject('ws_default', name)
    this.sessionId = this.store.startSession(this.projectId)
    this.turnIndex = 0
    this.previousSessionId = undefined

    this.initPipeline()
    this.saveCurrentState()

    return {
      projectId: this.projectId,
      sessionId: this.sessionId,
      dbPath,
    }
  }

  /**
   * Process a conversational turn through the extraction pipeline.
   */
  async processTurn(text: string, speaker: 'user' | 'system' = 'user'): Promise<ExtractionResult> {
    this.ensureInitialized()

    this.turnIndex++
    const turn: ConversationalTurn = {
      sessionId: this.sessionId!,
      turnIndex: this.turnIndex,
      speaker,
      text,
      timestamp: new Date(),
    }

    const result = await this.pipeline!.processTurn(turn, this.projectId! as NodeId)
    this.saveCurrentState()
    return result
  }

  /**
   * Approve a leaning decision → decided.
   * Uses fuzzy matching to find the target decision.
   */
  approveDecision(decisionHint: string): {
    success: boolean
    decisionId?: string
    statement?: string
    error?: string
  } {
    this.ensureInitialized()
    const model = this.store!.getProjectModel(this.projectId! as NodeId)

    // Find leaning decisions
    const leaning = Array.from(model.decisions.values()).filter(d => d.commitment === 'leaning')
    if (leaning.length === 0) {
      return { success: false, error: 'No leaning decisions to approve' }
    }

    // Fuzzy match using Jaccard similarity
    const target = findBestMatch(decisionHint, leaning.map(d => ({ id: d.id, text: d.statement })))
    if (!target) {
      return { success: false, error: `No matching leaning decision found for: "${decisionHint}"` }
    }

    const { createProvenance } = require('@gzoo/forge-core')
    const provenance = createProvenance(this.sessionId!, this.turnIndex, `Approved: ${target.text}`)

    this.store!.appendEvent(
      {
        type: 'NODE_PROMOTED',
        nodeId: target.id as NodeId,
        from: 'leaning',
        to: 'decided',
        trigger: 'explicit_commitment',
        wasAutomatic: false,
        provenance,
      },
      { projectId: this.projectId!, sessionId: this.sessionId!, turnIndex: this.turnIndex }
    )

    return { success: true, decisionId: target.id, statement: target.text }
  }

  /**
   * End the current session.
   */
  endSession(reason: 'explicit_close' | 'time_gap' = 'explicit_close'): void {
    if (this.store && this.sessionId) {
      try {
        this.store.endSession(this.sessionId, reason)
      } catch {
        // Session may already be ended
      }
    }
  }

  /**
   * Query cross-project memory.
   */
  queryMemory(query: string): {
    matches: Array<{
      statement: string
      projectName: string
      nodeType: string
      relevanceScore: number
      outcome?: string
      matchReason: string
    }>
  } {
    this.ensureInitialized()
    return this.store!.queryMemory({
      currentDecision: query,
      excludeProjectId: this.projectId!,
    })
  }

  /**
   * Get the current project model.
   */
  getModel(): ProjectModel {
    this.ensureInitialized()
    return this.store!.getProjectModel(this.projectId! as NodeId)
  }

  /**
   * Generate the session brief.
   */
  getBrief(): SessionBrief {
    this.ensureInitialized()
    if (this.pipeline) {
      return this.pipeline.generateBrief(
        this.projectId! as NodeId,
        this.sessionId!,
        this.previousSessionId
      )
    }
    // Fallback when LLM isn't configured — generate brief directly
    const model = this.store!.getProjectModel(this.projectId! as NodeId)
    return generateSessionBrief(model, this.store!, this.sessionId!, this.previousSessionId)
  }

  /**
   * Check if the server has an active project.
   */
  isInitialized(): boolean {
    return this.store !== null && this.projectId !== null && this.sessionId !== null
  }

  getProjectId(): string | null { return this.projectId }
  getSessionId(): string | null { return this.sessionId }
  getTurnIndex(): number { return this.turnIndex }
  getStore(): ProjectModelStore | null { return this.store }

  /**
   * Graceful shutdown.
   */
  shutdown(): void {
    this.endSession('explicit_close')
    if (this.store) {
      this.store.close()
      this.store = null
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.store || !this.projectId || !this.sessionId) {
      throw new Error('No active project. Use forge_init to create one.')
    }
  }

  private initPipeline(): void {
    if (!this.store) return

    try {
      const config = resolveProviderConfig()
      this.llmClient = createLLMClient(config)
    } catch {
      // LLM not configured — pipeline won't work but resources still can
      this.llmClient = null
    }

    if (this.llmClient) {
      this.pipeline = new ExtractionPipeline(this.store, this.llmClient)
      this.pipeline.initTrust(this.projectId! as NodeId, this.sessionId!)
      // Attempt Cortex connection (non-blocking, fails silently)
      this.pipeline.initCortex().catch(() => {})
    }
  }

  private saveCurrentState(): void {
    if (!this.projectId || !this.sessionId) return
    saveState({
      projectId: this.projectId,
      sessionId: this.sessionId,
      turnIndex: this.turnIndex,
      dbPath: getDbPath(),
    })
  }
}

// ─── Fuzzy Matching ─────────────────────────────────────────────────────────

function findBestMatch(
  hint: string,
  candidates: Array<{ id: string; text: string }>
): { id: string; text: string } | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const hintWords = new Set(hint.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let best: { id: string; text: string } | null = null
  let bestScore = 0

  for (const c of candidates) {
    const cWords = new Set(c.text.toLowerCase().split(/\s+/).filter(w => w.length > 2))
    const intersection = new Set([...hintWords].filter(w => cWords.has(w)))
    const union = new Set([...hintWords, ...cWords])
    const score = union.size > 0 ? intersection.size / union.size : 0

    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }

  // Require at least some overlap
  return bestScore > 0.1 ? best : null
}
