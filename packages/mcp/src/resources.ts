import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ForgeServer } from './server'
import { formatBriefAsMarkdown, formatDiffAsMarkdown, serializeModel, serializeTensions } from './serialization'

/**
 * Register all Forge resources on the MCP server.
 *
 * Resources are read-only context that Claude Code pulls in:
 * - forge://brief  — Session brief as markdown (primary memory injection)
 * - forge://model  — Full project model as JSON
 * - forge://tensions — Active tensions as JSON
 * - forge://diff   — What changed on the last turn
 */
export function registerResources(mcp: McpServer, forge: ForgeServer): void {

  // ── forge://brief ───────────────────────────────────────────────────────

  mcp.registerResource(
    'session-brief',
    'forge://brief',
    {
      description: 'IMPORTANT: Read this at the START of every session. This is your cross-session memory — it contains every decision, constraint, rejection, and open question from ALL previous sessions. Plan mode resets each session; this does not. Reading this prevents you from re-asking resolved questions or contradicting past decisions.',
      mimeType: 'text/markdown',
    },
    () => {
      if (!forge.isInitialized()) {
        return {
          contents: [{
            uri: 'forge://brief',
            mimeType: 'text/markdown',
            text: '# No active Forge project\n\nRun the `forge_init` tool with a project name to get started.',
          }],
        }
      }

      const brief = forge.getBrief()
      const markdown = formatBriefAsMarkdown(brief)

      return {
        contents: [{
          uri: 'forge://brief',
          mimeType: 'text/markdown',
          text: markdown,
        }],
      }
    }
  )

  // ── forge://model ───────────────────────────────────────────────────────

  mcp.registerResource(
    'project-model',
    'forge://model',
    {
      description: 'Full project model — all decisions, constraints, rejections, explorations, tensions, and artifacts as JSON.',
      mimeType: 'application/json',
    },
    () => {
      if (!forge.isInitialized()) {
        return {
          contents: [{
            uri: 'forge://model',
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'No active project' }),
          }],
        }
      }

      const model = forge.getModel()
      const serialized = serializeModel(model)

      return {
        contents: [{
          uri: 'forge://model',
          mimeType: 'application/json',
          text: JSON.stringify(serialized, null, 2),
        }],
      }
    }
  )

  // ── forge://tensions ────────────────────────────────────────────────────

  mcp.registerResource(
    'active-tensions',
    'forge://tensions',
    {
      description: 'Active and acknowledged tensions (conflicts) between decisions and constraints.',
      mimeType: 'application/json',
    },
    () => {
      if (!forge.isInitialized()) {
        return {
          contents: [{
            uri: 'forge://tensions',
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'No active project' }),
          }],
        }
      }

      const model = forge.getModel()
      const tensions = serializeTensions(model)

      return {
        contents: [{
          uri: 'forge://tensions',
          mimeType: 'application/json',
          text: JSON.stringify(tensions, null, 2),
        }],
      }
    }
  )

  // ── forge://diff ──────────────────────────────────────────────────────

  mcp.registerResource(
    'last-turn-diff',
    'forge://diff',
    {
      description: 'What changed on the last turn — model updates, promotions, tensions, and pipeline metadata as markdown.',
      mimeType: 'text/markdown',
    },
    () => {
      if (!forge.isInitialized()) {
        return {
          contents: [{
            uri: 'forge://diff',
            mimeType: 'text/markdown',
            text: '# No active Forge project\n\nRun the `forge_init` tool with a project name to get started.',
          }],
        }
      }

      const store = forge.getStore()!
      const sessionId = forge.getSessionId()!
      const turnIndex = forge.getTurnIndex()

      if (turnIndex === 0) {
        return {
          contents: [{
            uri: 'forge://diff',
            mimeType: 'text/markdown',
            text: '# No turns yet\n\nProcess a turn with `forge_process_turn` first.',
          }],
        }
      }

      // Get the last turn and its events
      const turns = store.getSessionTurns(sessionId)
      const lastTurn = turns.find(t => t.turnIndex === turnIndex)
      if (!lastTurn) {
        return {
          contents: [{
            uri: 'forge://diff',
            mimeType: 'text/markdown',
            text: '# Turn not found',
          }],
        }
      }

      const events = store.getSessionEvents(sessionId)
        .filter(e => e.turnIndex === turnIndex)

      const model = forge.getModel()
      const markdown = formatDiffAsMarkdown(lastTurn, events, model)

      return {
        contents: [{
          uri: 'forge://diff',
          mimeType: 'text/markdown',
          text: markdown,
        }],
      }
    }
  )
}
