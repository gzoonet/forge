/**
 * Hook capture — lightweight pipeline runner for Claude Code hooks.
 *
 * Called by the auto-capture hook (UserPromptSubmit) to process user messages
 * through the extraction pipeline in the background. Uses a separate turn counter
 * (starting at 10000) to avoid colliding with MCP-driven turns.
 *
 * Rules:
 * - NEVER print to stdout (would interfere with Claude Code)
 * - All errors logged to .forge/hook.log
 * - Always exits cleanly
 */

import * as fs from 'fs'
import * as path from 'path'
import { ProjectModelStore } from '@gzoo/forge-store'
import { ExtractionPipeline, createLLMClient, resolveProviderConfig } from '@gzoo/forge-extract'
import type { ConversationalTurn } from '@gzoo/forge-core'
import type { ForgeState } from './state'

const HOOK_STATE_FILE = path.join(process.cwd(), '.forge', 'hook-state.json')
const HOOK_LOG_FILE = path.join(process.cwd(), '.forge', 'hook.log')

interface HookState {
  turnIndex: number
}

function loadHookState(): HookState {
  try {
    if (fs.existsSync(HOOK_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(HOOK_STATE_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return { turnIndex: 10000 }
}

function saveHookState(state: HookState): void {
  try {
    fs.writeFileSync(HOOK_STATE_FILE, JSON.stringify(state, null, 2))
  } catch { /* ignore */ }
}

function logError(msg: string): void {
  try {
    const timestamp = new Date().toISOString()
    fs.appendFileSync(HOOK_LOG_FILE, `[${timestamp}] ${msg}\n`)
  } catch { /* ignore */ }
}

export async function hookCapture(text: string): Promise<void> {
  // Load main Forge state
  const stateFile = path.join(process.cwd(), '.forge', 'state.json')
  if (!fs.existsSync(stateFile)) {
    return // Forge not initialized — silently exit
  }

  let forgeState: ForgeState
  try {
    forgeState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  } catch (err: any) {
    logError(`Failed to read state.json: ${err.message}`)
    return
  }

  // Load hook-specific turn counter
  const hookState = loadHookState()
  hookState.turnIndex++

  let store: ProjectModelStore | undefined
  try {
    store = new ProjectModelStore(forgeState.dbPath)

    const config = resolveProviderConfig()
    const llm = createLLMClient(config)
    const pipeline = new ExtractionPipeline(store, llm)
    pipeline.initTrust(forgeState.projectId, forgeState.sessionId)

    const turn: ConversationalTurn = {
      sessionId: forgeState.sessionId,
      turnIndex: hookState.turnIndex,
      speaker: 'user',
      text,
      timestamp: new Date(),
    }

    await pipeline.processTurn(turn, forgeState.projectId)

    // Save updated hook state
    saveHookState(hookState)

  } catch (err: any) {
    logError(`Pipeline error: ${err.message}`)
  } finally {
    store?.close()
  }
}
