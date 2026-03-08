import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ForgeServer } from './server'
import { formatBriefAsMarkdown, serializeModel, serializeTensions } from './serialization'

/**
 * Register all Forge resources on the MCP server.
 *
 * Resources are read-only context that Claude Code pulls in:
 * - forge://brief  — Session brief as markdown (primary memory injection)
 * - forge://model  — Full project model as JSON
 * - forge://tensions — Active tensions as JSON
 */
export function registerResources(mcp: McpServer, forge: ForgeServer): void {

  // ── forge://brief ───────────────────────────────────────────────────────

  mcp.registerResource(
    'session-brief',
    'forge://brief',
    {
      description: 'IMPORTANT: Read this at the start of every session. Contains all project decisions, constraints, tensions, and goals from previous sessions. This is your project memory — it tells you what has already been decided so you do not contradict or re-ask resolved questions.',
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
}
