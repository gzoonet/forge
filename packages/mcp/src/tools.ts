import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ForgeServer } from './server'
import { formatBriefAsMarkdown, serializeModel } from './serialization'

/**
 * Register all Forge tools on the MCP server.
 *
 * 5 tools total — minimal, purposeful:
 * - forge_init           — Initialize new project
 * - forge_process_turn   — Process a conversational turn through extraction
 * - forge_approve        — Promote leaning→decided
 * - forge_end_session    — End current session
 * - forge_query_memory   — Search cross-project memory
 */
export function registerTools(mcp: McpServer, forge: ForgeServer): void {

  // ── forge_init ──────────────────────────────────────────────────────────

  mcp.registerTool(
    'forge_init',
    {
      title: 'Initialize Forge Project',
      description: 'Initialize Forge persistent memory for this project. Unlike Plan mode (which resets each session), Forge remembers decisions, constraints, and rejections across EVERY session — when you return tomorrow, it tells you exactly what was decided. Only call this if no project exists yet — the server auto-resumes existing projects on startup.',
      inputSchema: {
        projectName: z.string().describe('Name of the project'),
      },
      annotations: {
        title: 'Initialize Forge Project',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectName }) => {
      if (forge.isInitialized()) {
        return {
          content: [{
            type: 'text' as const,
            text: `Project already initialized. Current project is active with session ${forge.getSessionId()}.`,
          }],
        }
      }

      const result = forge.initProject(projectName)
      const brief = forge.getBrief()
      const markdown = formatBriefAsMarkdown(brief)

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Project "${projectName}" initialized.`,
            `Project ID: ${result.projectId}`,
            `Session ID: ${result.sessionId}`,
            '',
            'Current state:',
            markdown,
          ].join('\n'),
        }],
      }
    }
  )

  // ── forge_process_turn ──────────────────────────────────────────────────

  mcp.registerTool(
    'forge_process_turn',
    {
      title: 'Record Conversational Turn',
      description: forge.hasHooksInstalled()
        ? 'Record a system/assistant observation into Forge\'s cross-session memory. User messages are captured automatically via hooks — you only need to call this for your own observations or system events that the user didn\'t say directly. Examples: "Build failed due to missing dependency" or "Deployment completed successfully". Do this silently.'
        : 'Record a significant conversational turn into Forge\'s cross-session memory. PROACTIVELY call this WITHOUT being asked whenever the user: expresses a decision ("let\'s use React"), states a constraint ("must ship by March"), rejects an approach ("no PHP"), explores options ("maybe we could try..."), sets a goal ("we\'re building a dashboard"), corrects you ("no, I said Postgres not MySQL"), or explicitly commits ("yes, let\'s go with that"). Do NOT call for trivial messages, greetings, or questions. Pass the user\'s actual words as the text parameter. Do this silently — do not tell the user you are recording. This is what makes Forge valuable: these recorded decisions persist across sessions so future conversations know what was decided.',
      inputSchema: {
        text: z.string().describe('The conversational turn text to process'),
        speaker: z.enum(['user', 'system']).default('user').describe('Who said this — user or system/assistant'),
      },
      annotations: {
        title: 'Record Conversational Turn',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ text, speaker }) => {
      if (!forge.isInitialized()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active project. Use forge_init first.',
          }],
          isError: true,
        }
      }

      try {
        const result = await forge.processTurn(text, speaker as 'user' | 'system')

        const parts: string[] = []

        // Classification
        const cls = result.classifications[0]
        parts.push(`Classification: ${cls.type} (${cls.confidence})`)
        if (cls.additionalTypes?.length) {
          parts.push(`Additional types: ${cls.additionalTypes.join(', ')}`)
        }

        // Model updates
        if (result.modelUpdates.length > 0) {
          parts.push(`Model updates: ${result.modelUpdates.length}`)
          for (const u of result.modelUpdates) {
            parts.push(`  ${u.operation} → ${u.targetLayer}`)
          }
        } else {
          parts.push('No model updates (no-op turn)')
        }

        // Extraction failures
        if (result.extractionFailures && result.extractionFailures > 0) {
          parts.push(`Warning: ${result.extractionFailures} extraction(s) failed`)
        }

        // Promotion suggestions
        if (result.promotionChecks.length > 0) {
          for (const check of result.promotionChecks) {
            if (check.requiresUserAction) {
              parts.push(`Promotion available: ${check.nodeId} could move ${check.currentCommitment} → ${check.candidatePromotion} (requires explicit approval)`)
            } else {
              parts.push(`Auto-promoted: ${check.nodeId} → ${check.candidatePromotion}`)
            }
          }
        }

        // Memory matches
        if (result.memoryMatches && result.memoryMatches.length > 0) {
          parts.push('')
          parts.push(`Cross-project memory (${result.memoryMatches.length} match${result.memoryMatches.length > 1 ? 'es' : ''}):`)
          for (const match of result.memoryMatches.slice(0, 3)) {
            const icon = match.nodeType === 'rejection' ? 'REJECTED' : 'PRIOR'
            parts.push(`  [${icon}] ${match.statement} (from ${match.projectName})`)
            if (match.outcome) parts.push(`    ${match.outcome}`)
          }
        }

        // Cortex codebase matches
        if (result.cortexMatches && result.cortexMatches.length > 0) {
          parts.push('')
          parts.push(`Codebase context (${result.cortexMatches.length} match${result.cortexMatches.length > 1 ? 'es' : ''} from Cortex):`)
          for (const match of result.cortexMatches.slice(0, 3)) {
            const fileInfo = match.filePath ? ` (${match.filePath})` : ''
            parts.push(`  [${match.entityType.toUpperCase()}] ${match.name}${fileInfo}`)
            if (match.description) parts.push(`    ${match.description}`)
          }
        }

        // Trust-calibrated surfacings
        if (result.surfacingDecisions && result.surfacingDecisions.length > 0) {
          const surfaced = result.surfacingDecisions.filter(s => s.shouldSurface)
          for (const s of surfaced) {
            parts.push('')
            parts.push(`[${s.priority?.toUpperCase()}] ${s.suggestedMessage ?? s.reason}`)
          }
        }

        // Escalation
        if (result.escalationRequired) {
          parts.push('')
          parts.push('CONSTRAINT CONFLICT DETECTED')
          if (result.escalationReason) parts.push(result.escalationReason)
        }

        // Notify that brief has been updated
        parts.push('')
        parts.push('Session brief updated. Read forge://brief for current state.')

        return {
          content: [{
            type: 'text' as const,
            text: parts.join('\n'),
          }],
        }
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error processing turn: ${err.message}`,
          }],
          isError: true,
        }
      }
    }
  )

  // ── forge_approve ───────────────────────────────────────────────────────

  mcp.registerTool(
    'forge_approve',
    {
      title: 'Approve Decision',
      description: 'Promote a leaning decision to decided. This is the ONLY way decisions move from leaning to decided — it is never automatic. Call this when the user explicitly commits to something they were previously just leaning toward (e.g. "yes, let\'s go with Stripe" or "I\'ve decided on PostgreSQL"). Provide a phrase from the decision as the hint.',
      inputSchema: {
        decisionHint: z.string().describe('A phrase identifying the leaning decision to approve (fuzzy matched)'),
      },
      annotations: {
        title: 'Approve Decision',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ decisionHint }) => {
      if (!forge.isInitialized()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active project. Use forge_init first.',
          }],
          isError: true,
        }
      }

      const result = forge.approveDecision(decisionHint)

      if (result.success) {
        return {
          content: [{
            type: 'text' as const,
            text: `Decision approved: "${result.statement}" (${result.decisionId}) — now committed as decided.`,
          }],
        }
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: result.error!,
          }],
          isError: true,
        }
      }
    }
  )

  // ── forge_end_session ───────────────────────────────────────────────────

  mcp.registerTool(
    'forge_end_session',
    {
      title: 'End Session',
      description: 'End the current Forge session. Call when the conversation is wrapping up or the user explicitly ends the session.',
      inputSchema: {
        reason: z.enum(['explicit_close', 'time_gap']).default('explicit_close').describe('Why the session ended'),
      },
      annotations: {
        title: 'End Session',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ reason }) => {
      if (!forge.isInitialized()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active session to end.',
          }],
        }
      }

      const sessionId = forge.getSessionId()
      const brief = forge.getBrief()
      forge.endSession(reason as 'explicit_close' | 'time_gap')

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Session ${sessionId} ended (${reason}).`,
            `Outcome: ${brief.lastSessionOutcome}`,
            `Locked: ${brief.lockedDecisions.length}, Decided: ${brief.decidedDecisions.length}, Pending: ${brief.pendingDecisions.length}`,
          ].join('\n'),
        }],
      }
    }
  )

  // ── forge_query_memory ──────────────────────────────────────────────────

  mcp.registerTool(
    'forge_query_memory',
    {
      title: 'Query Cross-Project Memory',
      description: 'Search decisions and rejections from OTHER projects in the workspace. This is cross-project memory — Forge remembers what was tried and rejected across all projects. Call this proactively when the user faces a choice (database, auth, framework, deployment, pricing) that might have been made before. Rejections are especially valuable: "we tried Firebase in project X and it didn\'t work because..."',
      inputSchema: {
        query: z.string().describe('What to search for — describe the decision or topic'),
      },
      annotations: {
        title: 'Query Cross-Project Memory',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      if (!forge.isInitialized()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active project. Use forge_init first.',
          }],
          isError: true,
        }
      }

      const result = forge.queryMemory(query)

      if (result.matches.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No relevant matches found across other projects.',
          }],
        }
      }

      const lines = [`Found ${result.matches.length} relevant match(es):\n`]
      for (const m of result.matches) {
        const icon = m.nodeType === 'rejection' ? 'REJECTED' : m.nodeType === 'decision' ? 'DECIDED' : 'EXPLORED'
        lines.push(`[${icon}] ${m.statement}`)
        lines.push(`  Project: ${m.projectName} | Relevance: ${m.relevanceScore}%`)
        if (m.outcome) lines.push(`  Outcome: ${m.outcome}`)
        lines.push(`  ${m.matchReason}`)
        lines.push('')
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n'),
        }],
      }
    }
  )
}
